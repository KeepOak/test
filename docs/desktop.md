# Branch Agent desktop

The native client shares the runtime and interface with the local web application. It starts a loopback service, opens an authenticated Electron window, and keeps scheduling active when the window is hidden to the tray.

## Run and package

```sh
npm ci
npm run desktop
npm run package:desktop
```

The portable Windows folder is `release/Branch Agent-win32-x64/`; launch `Branch Agent.exe` inside it and keep the whole folder together. `npm run package:desktop -- --release` also makes the zip, its checksum and `Install Branch Agent.cmd`. The installer requires all three files together, verifies and preflights a private copy, then adds shortcuts and the uninstall entry. Installed copies can update from the app. Windows releases remain unsigned until a trusted publisher certificate is configured; the macOS build is signed with the project's own certificate once the owner turns signing on, which is what keeps its permissions across updates (see below).

Electron is a development dependency because it supplies the native window, platform tray and bundled runtime. Electron Packager creates the distributable directory. Fontsource packages supply locally bundled typefaces; each font's license accompanies it. The package includes only runtime files, public assets, production dependencies, package metadata and notices.

## State and configuration

Desktop private state and workspace default to separate `state` and `workspace` subdirectories beneath Electron's user-data directory for Branch Agent. `BRANCH_DATA_DIR` and `BRANCH_WORKSPACE` override them. Model connections can be saved in Settings with device-protected keys; explicit `BRANCH_PROVIDER` environment configuration takes precedence. See [configuration.md](configuration.md) for model, key-recovery and integration behavior.

`BRANCH_DESKTOP_HOME` can select a separate Electron profile, for example for an isolated evaluation. Profiles contain UI caches and the default state location. Do not point two running applications at the same data directory.

Forest/Daylight preferences live in the application database, so they survive service port changes and app restarts. The renderer cannot read Node APIs or the session-token file. The main process adds authorization only to the local window's API requests.

## Sign-in and updates

`chatgpt-auth.json` in the user data folder holds the ChatGPT sign-in, encrypted with Electron `safeStorage`, or, where the system has no key storage for it, sealed with the locker's key. The renderer only ever receives sign-in status, never tokens. Stable updates use the latest final `vX.Y.Z` release. The owner may opt into Beta, which also considers published `vX.Y.Z-beta.N` releases; a final release outranks its prereleases, and switching back never downgrades. Updates run in the main process (`updater.ts`): Branch downloads the selected archive to the temp folder, verifies the published SHA-256, and requires the embedded package name and version to match before any safety copy or hand-over. The checked archive is expanded and applied after the app exits. Automatic installation is off by default and checks that no task is running or awaiting an answer before hand-over. The renderer may open only `https://auth.openai.com/` and the project's GitHub pages through `branch:open-external`.

## macOS: the first open, and permissions that are kept

The Mac download is signed with a certificate the project made itself, with
`scripts/make-mac-signing-certificate.sh`. It costs nothing and it is not an Apple Developer ID. Here
is exactly what it does and does not do, because the two are easy to confuse.

**What it fixes.** macOS remembers a permission against the app's *identity*, not its name or its
place on disk. An ad-hoc seal — what the build falls back to with no certificate — makes that identity
a hash of the app's own contents, so every build is a different app and microphone, screen recording
and accessibility are asked for again on every update. Signing with a certificate makes the identity
the bundle identifier plus the certificate, neither of which changes between builds, so **permissions
granted once are kept across every later update**. The bundle identifier `com.keepoak.branch-agent` is
half of that identity: changing it throws away every grant, which is why a test pins its exact value.

**What it does not fix.** Nothing about the first-open warning. macOS still refuses to open the app
straight from a browser download, exactly as it does today. The way through, on macOS 15 and later
(Apple removed the old Control-click shortcut):

> **System Settings → Privacy & Security →** scroll to the message about Branch Agent **→ Open Anyway
> → Open.**

That is **once per install, not once per update** — the app the updater puts in place is not
quarantined, so later versions open without it. Only a paid Apple Developer ID and notarisation remove
the warning altogether; the packaging already prefers `APPLE_SIGNING_IDENTITY` and notarises with it
if the project ever buys one, and nothing else would need to change.

**The one release that asks again.** The release where the certificate first appears changes the app's
identity once, so every person grants microphone, screen recording and accessibility one final time.
Say so in that release's notes. Every update after it is silent.

**Windows is different and is not fixed by this.** Windows has no permissions to lose, but it shows
"Windows protected your PC" (More info → Run anyway) and, for an unsigned app, shows it again for
**every new release** until SmartScreen reputation builds. A self-made certificate buys nothing at all
on Windows — Microsoft treats it the same as no signature.

**How the build proves it.** After signing, `scripts/package-desktop.mjs` reads back the requirement
macOS will enforce (`codesign -d -r-`) and refuses the build unless it names
`com.keepoak.branch-agent` and a `certificate root`, and never a `cdhash`. The requirement is printed
as a one-line identity receipt, which belongs in the release notes:

```
Identity receipt: identifier "com.keepoak.branch-agent" and certificate root = H"…"
```

Signing is switched on by the repository variable `MAC_SIGNING_REQUIRED=true` (Settings, Secrets
and variables, Actions, Variables), set beside the three secrets `MAC_SIGNING_P12_BASE64`,
`MAC_SIGNING_P12_PASSWORD` and `MAC_SIGNING_SHA1`.

- **Switched on:** a missing certificate, a failed import, or a `cdhash` requirement refuses the
  release loudly, before anything is zipped. A release that would silently reset everyone's
  permissions therefore fails instead of shipping. `npm run package:desktop -- --release` does the
  same locally when `MAC_SIGNING_REQUIRED=true` is in the environment.
- **Not switched on:** the release goes ahead unsigned, exactly as before, with a warning in the job
  summary that every update will ask for permissions again. A plain local build is unsigned and silent.
- **A signing secret with no variable** refuses the release: that is a setup that was never finished.

## Installers and Stable releases

A version tag runs `.github/workflows/package.yml` on Windows, macOS and Linux build machines. After `scripts/package-desktop.mjs --release`, `scripts/package-installers.mjs` makes the installers from the same app:

| System | Installer | How it installs |
| --- | --- | --- |
| Windows | `Branch-Agent-Setup-windows-x64.exe` | One file, per person, no administrator. It unpacks the app to its own temporary folder and runs the app's own installer (`dist/install/install-cli.js`), the same one `Install Branch Agent.cmd` runs: Start-menu and desktop shortcuts, the Apps entry with its uninstaller, the previous copy kept in `<install>.previous`, saved work kept. Built with Inno Setup, which the Windows build machines already carry. |
| macOS | `Branch-Agent-macos-arm64.dmg`, `Branch-Agent-macos-x64.dmg` | The app beside a link to Applications. |
| Linux | `Branch-Agent-linux-x64.deb` | Installs to `/opt/branch-agent` and sets up Electron's sandbox helper. Use this one on Ubuntu 24.04 and later. |
| Linux | `Branch-Agent-linux-x64.AppImage` | Runs without installing. It needs unprivileged user namespaces for Electron's sandbox, which Ubuntu 24.04 and later turn off by default. |

Each installer is installed or opened once on its build machine and must load its window (`scripts/launch-smoke.mjs`, under `xvfb-run` on Linux) before anything is published. The Windows check installs, installs again over itself (keeping the previous copy) and uninstalls. Every download goes up with its `.sha256` and a GitHub build provenance record for `package.yml` at that tag, which is the record the Stable updater checks. For every release after 0.19.3 (the last one published without a record) the record is required: the updater checks it against the published checksum before downloading, refuses a release that has none, and waits when GitHub cannot be asked (`provenanceRequired` in `src/desktop/updater.ts`). The Stable updater keeps installing the four update archives by name (`src/desktop/release-assets.ts`); copies from the `.deb` or AppImage are updated by installing the newest `.deb` or AppImage instead.

A rehearsal tag, `v0.0.0-rehearsal.<n>`, runs the whole path and publishes a prerelease that no updater installs (Stable reads only the latest final release, and 0.0.0 is older than every Branch). It skips the integration and exact-commit CI gate, so it is never signed with any of Branch's keys (Android, Mac or Windows) and its downloads carry no phone app. Delete it once checked: `gh release delete v0.0.0-rehearsal.<n> --cleanup-tag --yes`.

## Signing the Windows setup file for free

Without signing, the release goes out unsigned: the build says so in its summary, and the release notes tell people how to get past SmartScreen's "Windows protected your PC". The workflow signs as soon as these are set, and refuses a half-finished setup. Signed, the program file keeps its own name and icon (Windows then says "Branch Agent", not "Electron", in its dialogs and Task Manager) and is signed before it is zipped or put in the setup file; the setup file is then signed too. Unsigned, the program file stays the stock Electron one, as described below. The settings:

- Secret `SIGNPATH_API_TOKEN` in the `release` environment (below): the API token of a SignPath CI user.
- Variable `SIGNPATH_ORGANIZATION_ID` in the same environment.
- Optional variables there: `SIGNPATH_PROJECT_SLUG` (default `Branch-Agent`) and `SIGNPATH_POLICY_SLUG` (default `release-signing`).

Signing runs for a pushed version tag only, never for a run started by hand or a rehearsal. In SignPath, limit the signing policy to this repository's `refs/tags/v*` builds as well.

### The release environment

Every signing key (SignPath, the Android keystore, the Mac certificates and notary key) belongs in the repository's `release` environment, not in the repository's own secrets. GitHub gives an environment's secrets only to jobs it lets into that environment, and `release` lets in final version tags only (`v1.2.3`, never a `-beta.N` or a rehearsal, never a branch). Its deployment rule lists the final tag shapes, `v` then one or two digits in each of the three parts (GitHub's tag rules can include patterns but not exclude them, so `v*` would let in betas and rehearsals too). `package.yml` asks for it in the two jobs that sign, and only when the run is for a final version tag. A run by hand from a branch, a rehearsal, `beta.yml` and every pull request get none of the keys, and say so the way a fork does. To build the signed Android app by hand, run `package.yml` from a release tag.

SignPath Foundation (https://signpath.org) signs open-source projects for free with a certificate it holds (issued to SignPath Foundation, so Windows shows that name as the publisher). To apply, the project needs: an OSI-approved licence with no commercial dual-licence (Branch is MIT); only open-source code, apart from system libraries; an actively maintained project that has already released and describes what it does on its download page; multi-factor sign-in for everyone on GitHub and on SignPath; named authors, reviewers and approvers; and a "Code signing policy" page that names SignPath, lists those people, and says the app sends no data anywhere without being asked (with links to the privacy policies of anything it bundles that does). Signed programs must be built from this repository by its own workflow, must not include tools made to find or exploit security holes, and must be uninstallable. Once accepted, SignPath gives the organization ID, project and policy names and a CI user token for the settings above. The first signed builds can still show SmartScreen until the certificate builds reputation.

## Smart App Control and the executable

Windows Smart App Control blocks unsigned executables it has never seen. The packager normally rewrites the executable's icon and version resources, so every build has a new, unknown hash; on a machine with Smart App Control on, that build is refused ("An Application Control policy has blocked this file"). Until releases are code-signed, `scripts/package-desktop.mjs` copies the stock Electron executable (a widely known hash) over `Branch Agent.exe` after packaging. Window, tray and taskbar icons are set at runtime, so only the file icon in Explorer differs. The update hand-over script keeps the previous version in `<install>.previous` and restores it when the new executable does not start within fifteen seconds.

## Verification boundary

The native test exercises a task that writes and verifies a file, checks renderer isolation, blocks navigation to a real local server outside the permitted origin, checks that tokens are absent from URL/HTML/session storage, changes appearance across reload and process restart, hides the window to tray, and verifies the process and loopback listener stop on quit.

The offline provider is deterministic. A working native shell does not establish live model access, a signed installer, automatic updates or complete capability parity.
