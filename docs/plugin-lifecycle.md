# Plugin comparisons and retained versions

Customize → Tools → Plugins → **Compare and restore versions** runs task fixtures against installed plugin tools and a local candidate folder or ZIP. It also supports installed add-on packages and checked updates prepared from their lists. Nothing is registered in the running tool catalog during comparison: hooks, providers and channels are never activated.

New catalog and add-on installations arrive staged. They must pass executable fixtures and be promoted before they can be enabled. Existing installations retain their previous owner approval. A first installation has an explicitly unavailable baseline; it is not reported as a successful baseline run. Plugins that expose only providers, channels or hooks cannot pass tool fixtures and remain staged.

Each fixture names a tool, primitive input arguments and an exact JSON result:

```json
{"id":"counting","cases":[{"id":"two-words","tool":"plugin.branch-starter.count","args":{"text":"two words"},"expected":{"words":2,"lines":1,"characters":9}}]}
```

Both versions use the same fixtures and, for previously approved plugins, the intersection of current owner grants and both manifests. Fresh candidates can exercise declared tools inside the fixture wall; this does not grant their permissions to a real task. Every evaluation uses a fresh host process and scratch directory, no network, no secrets and no owner write grants. Windows uses the existing held WSL runner and Linux bubblewrap. Evaluation tightens the wall to scratch and interpreter/runtime files. Missing WSL, Node or bubblewrap is a failed evaluation with its actual setup error. The weaker Windows activation option never applies to evaluation.

Results retain both scores, per-fixture outcomes, suite hash, full source hashes and the owner-grant hash. Empty, malformed, missing-tool, refused, truncated and failed runs cannot pass. Promotion requires all candidate fixtures to pass and no score regression. Equal scores are shown as unchanged, not as improvement. Fixtures establish behavior on those tasks only.

Promotion rechecks the installed source, candidate source, suite and current grants. Lifecycle locks and generation checks prevent an activation already waiting on I/O from registering old code after promotion. Promotion and restoration leave the plugin off; enabling remains a separate owner decision. Existing activation rules for network access and Windows weak-wall consent still apply.

Catalog versions retain the complete manifest and code, identified by a SHA-256 over both. Code-only hashes remain in catalog entries for loader integrity, while `versions[].versionSha256` identifies a restorable version. Add-on versions retain every package file, complete package metadata and provenance. Restoration names a full version fingerprint and the expected current fingerprint. Unevaluated staged versions cannot be restored into approval. A failed replacement restores previous files and metadata, switched off.

Owner API routes are `POST /api/plugin-catalog/status` (`id`), `/evaluate` (`id`, `source`, `suite`, optional first-install `kind`), `/promote` (`id`, `evaluationId`) and `/restore` (`id`, `sha256`, `expectedCurrent`). Status returns the fingerprint needed for restoration. `POST /api/plugin-catalog/add-ons/lists/stage-update` (`id`) retains a checked list candidate and returns its source for evaluation. Direct list replacement of plugin code is refused until that comparison succeeds. These operations are not exposed as autonomous activation tools.
