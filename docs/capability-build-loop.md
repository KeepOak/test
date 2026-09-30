# Building a missing capability

Branch can preserve an owner task while it acquires a missing capability. `seasons.bud` first tries the existing tools, then offers connectors or a generated tool. Each ordinary tool call still uses the task's permissions and current approval rules.

On Windows, generated tools run through WSL's Linux Node and bubblewrap. They have a scratch folder, no direct network, no Windows drives or saved credentials, and a bounded RPC channel back to Branch. WSL, Node or bubblewrap being absent produces a setup explanation; code never falls back to unrestricted Windows execution.

`settings.find` returns a development handoff when no setting matches. A failed name match does not itself authorize development. When the owner explicitly asks to add the setting, `seasons.request_setting` records the desired value and original task in a source-change request. The existing owner review creates the isolated source contract. Preparation alone does not implement or install the setting: development, tests, independent review, merge and the normal update path must still finish.

Protected merges record an immutable receipt. Packaged and live engine builds stamp up to 2,000 ancestor commits. A setting request automatically resumes only when the running engine includes its reviewed merge and the settings catalogue accepts its requested value. A changed version or manual confirmation alone is insufficient. Older builds without history can prove an exact merge only; missing history leaves the request waiting. Interrupted resumptions are not replayed automatically.

Generated tools carry evaluation receipts with source and suite hashes, counts, and optional baseline scores. Fixtures supply `input`, `expected`, and optional ordered `replies` (`tool`, `args`, `result`). Evaluations run with simulated replies, no live RPC tools, and no inherited filesystem write grants. Branch compares returned values outside generated code; expected answers are not sent into that process.

`seasons.revise_tool` runs the previous and candidate implementations against the retained and new cases. A failing candidate leaves the current tool active. A passing candidate preserves a rollback copy; `seasons.rollback_tool` restores it while retaining the regression suite. Receipts describe fixture performance, not a guarantee about arbitrary requests. This evaluation lifecycle covers generated tools; it does not certify arbitrary downloaded plugins or MCP servers.
