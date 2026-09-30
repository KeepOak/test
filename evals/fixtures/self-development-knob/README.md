The nightly `self-development-add-knob` task copies the four application files
in this directory into its fresh isolated engine workspace, under `knob-app/`.
It asks the real model to add `compactMode` across configuration, JSON schema,
control metadata, and the JavaScript settings reader.

The scorer parses actual JSON files and checks the JavaScript module against an
explicit reader contract, preserving the original reader. It never trusts the
answer text and never evaluates generated JavaScript. No judge model is needed.
Each nightly run starts from these original fixture files, so a previous result
cannot satisfy the next task.

This measures a bounded settings-code edit. It does not measure native UI
rendering, persistence through a running application, compilation, GitHub
publication, merge, or a released Branch update. A passing score must not be
reported as proof of any of those outcomes.

It is included in the full nightly suite through `evals/tasks/index.mjs`; the
scripted smoke subset does not include it. Once execution is authorized, it can
also be selected with `--only self-development-add-knob`.
