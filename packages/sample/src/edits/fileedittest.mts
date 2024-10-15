export function editTest() {
    def("FILE", env.files)

    $`- Implement the functions with TODO.
- Remove all comments.
`

    defOutputProcessor((output) => {
        const { fileEdits } = output
        if (Object.keys(fileEdits).length !== env.files.length)
            throw new Error("no file edits")
        for (const [fn, fe] of Object.entries(fileEdits)) {
            const res = fe.after
            if (/^\s*(#|\/\/).*$/.test(res))
                throw new Error(fn + " some comments were not removed")
            if (res.includes("// BODY"))
                throw new Error(fn + " the // BODY comment was not removed")
        }
    })
}
