# Finding a running Branch from the CLI

`branch quit` and `branch --version --json` previously looked only in `BRANCH_DATA_DIR` or the current directory's `.branch`. A desktop launch normally writes its running note under its user-data `state` folder, so an unconfigured CLI launched elsewhere could say Branch was not running.

Without an explicit `BRANCH_DATA_DIR`, these two management commands now check the current-directory `.branch`, the configured `BRANCH_DESKTOP_HOME/state`, and the platform's normal desktop state folder. An absolute `BRANCH_EXECUTABLE` also allows the existing portable-marker resolver to find that executable's portable state. They choose a folder only when its existing running note names a live process. If several folders are running, they ask for an explicit `BRANCH_DATA_DIR` instead of choosing one.

Discovery reads only the existing running metadata and checks process existence. It does not scan profiles, open databases, migrate files, or read session tokens. Quitting then uses the existing authenticated local quit path and existing daemon-stop fallback; no new process-kill fallback is added. Update, uninstall and rollback retain their existing explicit install/data context.

SELF-034 remains partial: discovery is a concrete fix for the wrong-folder case. The original missing dogfood receipt is unavailable, and a gateway engine quitting is not proof that every separate desktop shell has exited. Installed behavior and self-fix-task acceptance remain unverified. Tests, builds and runtime execution are deferred by the owner.
