Tool scripts call Branch tools through `branch.call(name, args)` and return only
their selected result to the model. This saves a separate model round trip for
each tool call. Scripts name their tools in advance, cannot invoke `tools.script`
recursively, and run as subprocesses rather than inside the engine.

On Windows, scripts require an installed Docker engine with a Linux Node image
already available locally. The image is the existing sandbox-backends image
setting; the default is `node:22-alpine`. Branch never installs Docker or pulls
an image for this operation. A missing engine/image produces a failed script
result. There is no host execution fallback.
The separate unattended Budding path retains its existing Windows refusal.

The container has no network, a read-only filesystem, no capabilities, a
non-root user, limits on processes/memory/CPU, and only the generated script
folder mounted read-only. Its writable temporary space is bounded. Branch's
workspace, data, credentials and Docker socket are not mounted. RPC uses only
the subprocess's standard pipes. macOS/Linux retain their existing system wall.

Each RPC request runs through the original task's engine call path: permissions,
source identity, approval policy, shared budget, cancellation, journal, loop
guard, rate limits, tool deadline, receipts and result redaction. An approval
must be handled outside the script; code mode supplies no implicit yes.

Limits: 32 KiB source, 16 declared tools, 50 requests, 64 KiB request/reply
frames, 64 KiB total stdout/stderr, 60 KiB final answer, and 120 seconds maximum.
Every RPC call charges a step to the original task's shared budget. Timeout or
cancellation aborts in-flight tool contexts, discards queued requests, terminates
the subprocess and requests container removal. Cleanup failure may leave a
named `branch-code-*` container for an operator to remove; no success is claimed
for a stopped script.

Upstream reviewed: Hermes's MIT-licensed
[code_execution_tool.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/code_execution_tool.py),
[code_execution_rpc.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/code_execution_rpc.py)
and [license](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE).
The existing Branch JavaScript RPC host is retained and extended. These Python
modules are not copied into Branch's TypeScript engine.

This change has source-review evidence only. Windows Docker execution, POSIX
regression coverage and hostile-script containment need authorized tests before
it is used as proof of working isolation.
