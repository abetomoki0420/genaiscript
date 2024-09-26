/* spellchecker: disable */
import { Octokit } from "octokit"
import { createPatch } from "diff"

const workflow = env.vars.workflow || "build.yml"
const ffid = env.vars.failure_run_id
const lsid = env.vars.success_run_id
const branch =
    env.vars.branch ||
    (await host.exec("git branch --show-current")).stdout.trim()

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
})
const { owner, repo } = await getRepoInfo()

script({
    system: ["system", "system.files"],
    cache: "gh-investigator",
})

const runs = await listRuns(workflow, branch)

// first last success
const lsi = lsid
    ? runs.findIndex(({ id }) => id === lsid)
    : runs.findIndex(({ conclusion }) => conclusion === "success")
const ls = runs[lsi]
console.log(
    `> last success: ${ls.id}, ${ls.created_at}, ${ls.head_sha}, ${ls.html_url}`
)
const ff = ffid ? runs.find(({ id }) => id === ffid) : runs[lsi - 1]
if (!ff) cancel("failure run not found")
console.log(
    `> first failure: ${ff.id}, ${ff.created_at}, ${ff.head_sha}, ${ff.html_url}`
)
if (ff.conclusion !== "failure") cancel("failure run not found")

const gitDiff = await host.exec(
    `git diff ${ls.head_sha} ${ff.head_sha} -- . :!**/genaiscript.d.ts`
)
console.log(`> source diff: ${(gitDiff.stdout.length / 1000) | 0}kb`)

// download logs
const lsjobs = await downloadRunLog(ls.id)
const lsjob = lsjobs[0]
const lslog = lsjob.text
console.log(
    `> last success log: ${(lslog.length / 1000) | 0}kb ${lsjob.logUrl}`
)
const ffjobs = await downloadRunLog(ff.id)
const ffjob = ffjobs[0]
const fflog = ffjob.text
console.log(
    `> first failure log: ${(fflog.length / 1000) | 0}kb  ${ffjob.logUrl}`
)

const logDiff = diffJobLogs(lslog, fflog)
console.log(`> log diff: ${(logDiff.length / 1000) | 0}kb`)

// include difss
def("GIT_DIFF", gitDiff, {
    language: "diff",
    maxTokens: 10000,
    lineNumbers: true,
})
def("LOG_DIFF", logDiff, {
    language: "diff",
    maxTokens: 20000,
    lineNumbers: false,
})
$`Your are an expert software engineer and you are able to analyze the logs and find the root cause of the failure.

- GIT_DIFF contains a diff of 2 run commits
- LOG_DIFF contains a diff of 2 runs in GitHub Action
- The first run is the last successful run and the second run is the first failed run

Add links to run logs.

Analyze the diff in LOG_DIFF and provide a summary of the root cause of the failure.

If you cannot find the root cause, stop.

Generate a diff with suggested fixes. Use a diff format.`

writeText(
    `## Investigator report
- [run first failure](${ff.html_url})
- [run last success](${ls.html_url})
- [commit diff](https://github.com/${owner}/${repo}/compare/${ls.head_sha}...${ff.head_sha})

`,
    { assistant: true }
)

/*-----------------------------------------

GitHub infra

-----------------------------------------*/
async function getRepoInfo() {
    const repository = process.env.GITHUB_REPOSITORY
    if (repository) {
        const [owner, repo] = repository.split("/")
        return { owner, repo }
    }
    const remoteUrl = (await host.exec("git config --get remote.origin.url"))
        .stdout
    const match = remoteUrl.match(/github\.com\/(?<owner>.+)\/(?<repo>.+)$/)
    if (!match) {
        throw new Error(
            "Could not parse repository information from remote URL"
        )
    }
    const { owner, repo } = match.groups
    return { owner, repo }
}

async function listRuns(workflow_id: string, branch: string) {
    // Get the workflow runs for the specified workflow file, filtering for failures
    const {
        data: { workflow_runs },
    } = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id,
        branch,
        per_page: 100,
    })
    const runs = workflow_runs.filter(
        ({ conclusion }) => conclusion !== "skipped"
    )
    return runs
}

async function downloadRunLog(run_id: number) {
    const res = []
    // Get the jobs for the specified workflow run
    const {
        data: { jobs },
    } = await octokit.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id,
    })
    for (const job of jobs) {
        const { url: logUrl } =
            await octokit.rest.actions.downloadJobLogsForWorkflowRun({
                owner,
                repo,
                job_id: job.id,
            })
        const { text } = await fetchText(logUrl)
        res.push({ ...job, logUrl, text })
    }
    return res
}

function diffJobLogs(firstLog: string, otherLog: string) {
    let firsts = parseJobLog(firstLog)
    let others = parseJobLog(otherLog)

    // assumption: the list of steps has not changed
    const n = Math.min(firsts.length, others.length)
    firsts = firsts.slice(0, n)
    others = others.slice(0, n)

    // now do a regular diff
    const f = firsts
        .map((f) =>
            f.title ? `##[group]${f.title}\n${f.text}\n##[endgroup]` : f.text
        )
        .join("\n")
    const l = others
        .map((f) =>
            f.title ? `##[group]${f.title}\n${f.text}\n##[endgroup]` : f.text
        )
        .join("\n")
    const d = createPatch("log.txt", f, l, undefined, undefined, {
        ignoreCase: true,
        ignoreWhitespace: true,
    })
    return d
}

function parseJobLog(text: string) {
    const lines = cleanLog(text).split(/\r?\n/g)
    const groups: { title: string; text: string }[] = []
    let current = groups[0]
    for (const line of lines) {
        if (line.startsWith("##[group]")) {
            current = { title: line.slice("##[group]".length), text: "" }
        } else if (line.startsWith("##[endgroup]")) {
            if (current) groups.push(current)
            current = undefined
        } else {
            if (!current) current = { title: "", text: "" }
            current.text += line + "\n"
        }
    }
    if (current) groups.push(current)

    const ignoreSteps = [
        "Runner Image",
        "Fetching the repository",
        "Checking out the ref",
        "Setting up auth",
        "Setting up auth for fetching submodules",
        "Getting Git version info",
        "Initializing the repository",
        "Determining the checkout info",
        "Persisting credentials for submodules",
    ]
    return groups.filter(({ title }) => !ignoreSteps.includes(title))
}

function cleanLog(text: string) {
    return text
        .replace(
            // timestamps
            /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2,}Z /gm,
            ""
        )
        .replace(/\x1b\[[0-9;]*m/g, "") // ascii colors
}
