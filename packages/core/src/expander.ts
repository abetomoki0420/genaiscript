import {
    ChatCompletionsOptions,
    RequestError,
    getChatCompletions,
} from "./chat"
import {
    Fragment,
    PromptTemplate,
    allChildren,
    rangeOfFragments,
    rootFragment,
} from "./ast"
import { Edits } from "./edits"
import { commentAttributes, stringToPos } from "./parser"
import {
    assert,
    concatArrays,
    fileExists,
    readText,
    relativePath,
    splitPath,
} from "./util"
import {
    evalPrompt,
    extractFenced,
    renderFencedVariables,
    staticVars,
} from "./template"
import { host } from "./host"
import { inspect } from "./logging"
import { initToken } from "./oai_token"

const defaultModel = "gpt-4"
const defaultTemperature = 0.2 // 0.0-2.0, defaults to 1.0
const defaultMaxTokens = 800

export interface FragmentTransformResponse {
    /**
     * Zero or more edits to apply.
     */
    edits: Edits[]

    /**
     * A map of file updates
     */
    fileEdits: Record<string, { before: string; after: string }>

    /**
     * MD-formatted trace.
     */
    trace: string

    /**
     * LLM output.
     */
    text: string

    /**
     * Summary of the output generated by the LLM
     */
    summary?: string
}

// 'foo.bar.baz' -> [ 'foo', 'foo.bar', 'foo.bar.baz' ]
function prefixes(w: string) {
    const words = w.split(".")
    return words.map((_, i) => words.slice(0, i + 1).join("."))
}

function trimNewlines(s: string) {
    return s.replace(/^\n*/, "").replace(/\n*$/, "")
}
const fence = "```````````````"
export function fenceMD(t: string, contentType = "markdown") {
    return `\n${fence}${contentType}\n${trimNewlines(t)}\n${fence}\n`
}
function numberedFenceMD(t: string, contentType = "js") {
    return fenceMD(
        t
            .split(/\r?\n/)
            .map((l, i) => ("" + (i + 1)).padStart(3) + ": " + l)
            .join("\n"),
        contentType
    )
}

async function callExpander(r: PromptTemplate, vars: ExpansionVariables) {
    let promptText = ""
    let errors = ""
    let success = true
    const env = new Proxy(vars, {
        get: (target: any, prop, recv) => {
            const v = target[prop]
            if (v === undefined) {
                errors += `-  \`env.${String(prop)}\` not defined\n`
                return ""
            }
            return v
        },
    })
    let logs = ""
    try {
        await evalPrompt(
            {
                env,
                text: (body) => {
                    promptText +=
                        body.replace(/\n*$/, "").replace(/^\n*/, "") + "\n\n"

                    const idx = body.indexOf(vars.error)
                    if (idx >= 0) {
                        const msg = body
                            .slice(idx + vars.error.length)
                            .replace(/\n[^]*/, "")
                        throw new Error(msg)
                    }
                },
                prompt: () => {},
                systemPrompt: () => {},
            },
            r.jsSource,
            (msg) => {
                logs += msg + "\n"
            }
        )
    } catch (e) {
        success = false
        const m = /at eval.*<anonymous>:(\d+):(\d+)/.exec(e.stack)
        const info = m ? ` at prompt line ${m[1]}, column ${m[2]}` : ""
        errors += `-  ${e.name}: ${e.message}${info}\n`
    }
    return { logs, errors, success, text: promptText }
}

async function expandTemplate(
    template: PromptTemplate,
    fragment: Fragment,
    vars: ExpansionVariables
) {
    const varName: Record<string, string> = {}
    for (const [k, v] of Object.entries(vars)) {
        if (!varName[v]) varName[v] = k
    }
    const varMap = vars as any as Record<string, string | any[]>

    // we put errors on top so they draw attention
    let trace = `
# Prompt trace

@@errors@@

## Prompt template "${template.title}" (\`${template.id}\`)
${numberedFenceMD(template.jsSource)}

`

    let errors = ``

    const attrs = commentAttributes(fragment)
    const cat = categoryPrefix(template, fragment, attrs)
    const prompt = await callExpander(template, vars)

    const expanded = cat.text + "\n" + prompt.text
    errors += prompt.errors

    trace += cat.info

    // always append, even if empty - should help with discoverability:
    // "Oh, so I can console.log() from prompt!"
    trace += `\n## console output\n`
    if (prompt.logs?.length) trace += fenceMD(prompt.logs)
    else trace += `> tip: use \`console.log()\` from prompt.js files`

    trace += "\n## Expanded prompt\n"
    trace += fenceMD(prompt.text)
    trace += traceVars()

    trace = trace.replace("@@errors@@", errors)

    let systemText = ""
    let model = template.model
    let temperature = template.temperature
    let max_tokens = template.maxTokens

    trace += `## System prompt\n`

    const systems = (template.system ?? []).slice(0)
    if (!systems.includes("system")) systems.unshift("system")
    for (let i = 0; i < systems.length; ++i) {
        let systemTemplate = systems[i]
        let system = fragment.file.project.getTemplate(systemTemplate)
        if (!system) {
            if (systemTemplate)
                trace += `\n** error: \`${systemTemplate}\` not found\n`
            if (i > 0) continue
            systemTemplate = "system"
            system = fragment.file.project.getTemplate(systemTemplate)
            assert(!!system)
        }

        const sysex = (await callExpander(system, vars)).text
        systemText += sysex + "\n"

        model = model ?? system.model
        temperature = temperature ?? system.temperature
        max_tokens = max_tokens ?? system.maxTokens

        trace += `###  template: \`${systemTemplate}\`\n`
        if (system.model) trace += `-  model: \`${system.model || ""}\`\n`
        if (system.temperature !== undefined)
            trace += `-  temperature: ${system.temperature || ""}\n`
        if (system.maxTokens !== undefined)
            trace += `-  max tokens: ${system.maxTokens || ""}\n`

        trace += numberedFenceMD(system.jsSource)
        trace += "#### Expanded system prompt"
        trace += fenceMD(sysex)
    }

    model = model ?? fragment.project.coarchJson.model ?? defaultModel
    temperature = temperature ?? defaultTemperature
    max_tokens = max_tokens ?? defaultMaxTokens

    return {
        expanded,
        errors,
        trace,
        success: prompt.success,
        model,
        temperature,
        max_tokens,
        systemText,
    }

    function isComplex(k: string) {
        const v = varMap[k]
        if (typeof v === "string" && varName[v] != k) return false
        return (
            typeof v !== "string" ||
            v.length > 40 ||
            v.trim().includes("\n") ||
            v.includes("`")
        )
    }

    function traceVars() {
        let info = "\n\n## Variables\n"

        info += "Variables are referenced through `env.NAME` in prompts.\n\n"

        for (const k of Object.keys(vars)) {
            if (isComplex(k)) continue
            const v = varMap[k]
            if (typeof v === "string" && varName[v] != k)
                info += `-   env.**${k}**: same as **${varName[v]}**\n\n`
            else info += `-   env.**${k}**: \`${v}\`\n\n`
        }

        for (const k of Object.keys(vars)) {
            if (!isComplex(k)) continue
            const v = varMap[k]
            info += `-   env.**${k}**${fenceMD(
                typeof v === "string" ? v : inspect(v),
                typeof v === "string" ? "" : "js"
            )}\n`
        }

        return info
    }
}

function categoryPrefix(
    template: PromptTemplate,
    frag: Fragment,
    attrs: Record<string, string>
) {
    let text = ""
    let info = ""
    const used = new Set<string>()
    if (template.categories?.length || attrs["@prompt"]) {
        info += "\n## Inline prompts\n"

        info += `\nAdded as comment at the end of a fragment: 

\`\`\`markdown
Lorem ipsum...

<!-- @prompt.NAME 
You are concise.
!-->
\`\`\`
        

`

        const prefs = template.categories?.length
            ? concatArrays(
                  ...template.categories.map((s) => prefixes("@prompt." + s))
              )
            : ["@prompt"]
        for (const pref of prefs) {
            if (used.has(pref)) continue
            used.add(pref)
            if (attrs[pref] === undefined) {
                info += `-   **${pref}** missing\n`
            } else {
                const v = attrs[pref]
                info += `-   **${pref}**)\n${trimNewlines(v)}\n`
                text += attrs[pref]
            }
        }
        info += "\n"
    }

    return { info, text }
}

function fragmentVars(
    template: PromptTemplate,
    templates: PromptDefinition[],
    frag: Fragment,
    promptOptions: { ignoreOutput?: boolean } & any
) {
    const { file } = frag
    const project = file.project
    const ignoreOutput = !!promptOptions?.ignoreOutput

    const links: LinkedFile[] = []
    if (!ignoreOutput) {
        for (const fr of allChildren(frag, true)) {
            for (const ref of fr.references) {
                const file = project.allFiles.find(
                    (f) => f.filename === ref.filename
                )
                if (!file) continue

                const fn = relativePath(host.projectFolder(), file.filename)
                if (!links.find((lk) => lk.filename === fn))
                    links.push({
                        label: ref.name,
                        filename: fn,
                        content: file.content,
                    })
            }
        }
    }
    const parents: LinkedFile[] = []
    if (frag.parent)
        parents.push({
            label: frag.parent.title,
            filename: relativePath(
                host.projectFolder(),
                frag.parent.file.filename
            ),
            content: frag.parent.file.content,
        })
    const attrs = commentAttributes(frag)

    const vars: Partial<ExpansionVariables> = {
        ...staticVars(),
        file: {
            filename: file.filename,
            label: "current",
            content: file.content,
        },
        links,
        parents,
        promptOptions,
        template,
        templates,
        vars: attrs,
    }
    return { vars }
}

export type RunTemplateOptions = ChatCompletionsOptions & {
    infoCb?: (partialResponse: FragmentTransformResponse) => void
    readClipboard?: () => Promise<string>
    promptOptions?: any
    maxCachedTemperature?: number
}

export async function runTemplate(
    template: PromptTemplate,
    templates: PromptDefinition[],
    fragment: Fragment,
    options?: RunTemplateOptions
): Promise<FragmentTransformResponse> {
    const { requestOptions = {} } = options || {}
    const { signal } = requestOptions
    const { vars } = fragmentVars(
        template,
        templates,
        fragment,
        options.promptOptions
    )
    if (vars.vars && template.readClipboard && options?.readClipboard)
        vars.clipboard = await options.readClipboard()
    let {
        expanded,
        success,
        trace,
        model,
        temperature,
        max_tokens,
        systemText,
    } = await expandTemplate(template, fragment, vars as ExpansionVariables)

    trace += "\n\n## Final prompt\n\n"

    if (model) trace += `-  model: \`${model || ""}\`\n`
    if (temperature !== undefined)
        trace += `-  temperature: ${temperature || ""}\n`
    if (max_tokens !== undefined)
        trace += `-  max tokens: ${max_tokens || ""}\n`

    trace += fenceMD(expanded)

    // if the expansion failed, show the user the trace
    if (!success) {
        return {
            trace,
            text: "# Template failed\nSee info below.\n" + trace,
            edits: [],
            fileEdits: {},
        }
    }

    let text: string
    try {
        await initToken()
        options?.infoCb?.({
            edits: [],
            trace,
            text: "> Waiting for response...",
            fileEdits: {},
        })
        text = await getChatCompletions(
            {
                model,
                temperature,
                max_tokens,
                messages: [
                    {
                        role: "system",
                        content: systemText,
                    },
                    {
                        role: "user",
                        content: expanded,
                    },
                ],
            },
            options
        )
    } catch (error: unknown) {
        if (error instanceof RequestError) {
            trace += `## Request error\n\n`
            if (error.body) {
                trace += `\n> ${error.body.message}\n\n`
                trace += `-  type: \`${error.body.type}\`\n`
                trace += `-  code: \`${error.body.code}\`\n`
            }
            trace += `-   status: \`${error.status}\`, ${error.statusText}\n`
            options.infoCb({
                edits: [],
                trace,
                text: "Request error",
                fileEdits: {},
            })
        } else if (signal?.aborted) {
            trace += `## Request cancelled
            
The user requested to cancel the request.
`
            options.infoCb({
                edits: [],
                trace,
                text: "Request cancelled",
                fileEdits: {},
            })
        }
        throw error
    }

    const edits: Edits[] = []
    const obj = {
        label: template.title,
        filename: fragment.file.filename,
    }

    trace += "\n\n## AI Output\n\n" + fenceMD(text)

    const extr = extractFenced(text)

    trace += `

### Extracted Variables

${renderFencedVariables(extr)}
`

    const res: FragmentTransformResponse = {
        edits,
        fileEdits: {},
        trace,
        text,
    }
    const { fileEdits } = res

    const links: string[] = []
    for (const [name, val] of Object.entries(extr.vars)) {
        console.log({ name })
        if (name.startsWith("File ")) {
            delete extr.vars[name]
            const n = name.slice(5).trim().replace(/^\.\//, "")
            const fn = host.resolvePath(fragment.file.filename, "..", n)
            const curr = fragment.references.find(
                (r) => host.resolvePath(r.filename) === fn
            )?.filename

            if (await fileExists(fn)) {
                const content = await readText(fn)
                if (content !== val) {
                    fileEdits[fn] = { before: content, after: val }
                    edits.push({
                        label: `Update ${fn}`,
                        filename: fn,
                        type: "replace",
                        range: [[0, 0], stringToPos(content)],
                        text: val,
                    })
                }
            } else {
                fileEdits[fn] = { before: null, after: val }
                edits.push({
                    label: `Create ${fn}`,
                    filename: fn,
                    type: "createfile",
                    text: val,
                    overwrite: true,
                })
            }

            if (!curr && host.resolvePath(fragment.file.filename) !== fn)
                links.push(`-   [${n}](./${n})`)
        }
        if (name === "SUMMARY") {
            res.summary = val
            delete extr.vars[name]
        }
    }

    const keys = Object.keys(extr.vars)
    // if there is only one "Foo: ..." thing left, assume it's the output
    if (keys.length == 1) {
        text = extr.vars[keys[0]]
    }

    text = text.trim()

    const m = /^(```+)(\w*)\n/.exec(text)
    if (m && text.endsWith(m[1]))
        text = text.slice(m[0].length, -m[1].length).trim()

    if (links.length)
        edits.push({
            ...obj,
            type: "insert",
            pos: fragment.endPos,
            text: `\n\n${links.join("\n")}`,
        })

    return res
}
