# Adapting capabilities in a conversation

Branch routes capability requests to its existing tools. A request mentioning settings, skills,
installation or changes to Branch preloads relevant tools that the task is permitted to discover.
Disabled tools stay disabled, and the existing tool context budget still applies.

| Request | Existing execution path | Evidence to check |
| --- | --- | --- |
| Change Branch's settings | Find, read, change and undo through the settings tools | Read back the saved value |
| Learn or reuse a procedure | Skill listing, reading, workspace sync and readiness | Enabled version and a successful trial |
| Install or extend a capability | Permitted command runner, MCP, OpenAPI or add-on workflow | Compatibility, installation and an actual successful call |
| Remember useful knowledge | Owner-scoped memory search and storage | Saved fact with evidence, recalled in a later task |
| Change Branch's code | Isolated source contract, implementation, tests and checked integration | Exact tested change, recovery plan and installed-version check |

These are routes, not promises that every tool is enabled. Add-on drafts still require the existing
installation review. Skills and extensions retain their existing format and compatibility limits.
An approved task does not acquire another task's permissions or credential access.

If an action request receives an unsupported first-person inability claim before any tool is used,
the runtime gives the model one chance to inspect its tools. Repeating the claim without checking
ends the task as unfinished. Tool results, explicit permission refusals, explanation and writing
requests, dry runs, isolated graders and sealed learning tasks do not trigger that correction.

The guidance calls for planning, inspecting results, repairing failures within the existing limits,
and retaining verified lessons. It does not introduce a new unrestricted self-modification engine.
A merged change is not evidence that a running installation has updated, and scripted tests do not
establish that every model will follow the workflow.
