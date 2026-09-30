# Preparing a WinGet submission

`scripts/winget-manifest.mjs` produces three review manifests for the existing
per-user x64 Inno installer. It reads the already-built installer and its named
SHA-256 file, verifies their match, and writes into an explicitly chosen **new**
directory. It does not build, sign, run, download or submit an installer.

For a stable release, after its installer and checksum exist:

```sh
node scripts/winget-manifest.mjs --version 0.19.4 --release-dir release --out winget-review-0.19.4
```

Use the actual release version. The identifier `KeepOak.BranchAgent` follows the
existing Windows app identity; the display name and publisher match the current
Add/Remove Programs entry. The registry product code is the existing
`BranchAgent` uninstall-key name. Inno supplies its documented silent switches;
the app's own installer owns the eventual app directory and uninstall entry.

Before submission, the maintainer must confirm that the stable release URL
exists and yields the same installer bytes, its embedded version and signature
are correct, silent installation/upgrade/uninstallation preserve saved work,
and the installed registry metadata matches these declarations. Run the current
WinGet manifest validation and check identifier availability in the community
repository. Those checks are not performed by the generator. Copy the reviewed
files into `manifests/k/KeepOak/BranchAgent/<version>/` and request a listing only
after that acceptance. A generated manifest does not establish a published listing.

The Linux `.deb` self-update policy remains separate: this generator does not
change the updater's existing refusal to replace package-manager-owned files.
