# Modal background motion

Acceptance: decorative scenery keeps its last frame while first-run setup covers it or a dialog takes focus, resumes after the last covering overlay closes, and does not wake while hidden or resting. Dialog entrance/progress motion, OS reduced motion and Keep things still remain unchanged.

Implementation:
- `public/app/styles/modal-motion.css` pauses only `#bgLayer .paint11` under direct app setup/dialog overlays
- `public/app/shell/procbg.js` parks procedural drawing without scheduled callbacks while covered, hidden or resting. Drawing otherwise uses a frame-rate timer followed by one RAF, rather than calling RAF on every display frame even when no drawing is due
- `tests/modal-background-motion.test.mjs` covers the scheduler and real computed CSS behavior with synthetic DOM

Validation on 2026-10-01:
- Three deterministic scheduler tests passed, including multiple overlays, dismissal during hidden/resting states, duplicate wake prevention, disposal and frame-budget compensation
- JavaScript syntax and whitespace checks passed
- Native Windows pre-push validation after normal protected base 4f0b961244721ad53d05e77c9ee86d5e91fb6bb6 integration: tsc --noEmit and npm run build passed; modal-background-motion plus window-sleep passed all nine tests (23.549 seconds). This includes all three scheduler tests, strengthened real computed-CSS transformed-frame preservation, nested overlays, reduced-motion/Keep things still, and five existing sleep regressions
- Independent review found no blockers for the narrow scope. Procedural position state is retained, but absolute-time firefly alpha can change phase on resume

Scope: this does not pause video/GIF scenery, avatars or pets. It does not establish a CPU, GPU-utilization, energy or battery improvement. The observed native OAuth-error high-CPU state needs an identical-build A/B with this patch and graphics status recorded, followed by hardware-accelerated Linux/Windows reproduction. The cloud GPU process can perform software rendering; process CPU is not GPU utilization.

Returning index integration: normal protected ed72ea2f1297d01f56185cf13177f1ce802f25ad merge retains both local-models.css and modal-motion.css in alphabetical order. Original procedural implementation, modal stylesheet and modal fixture blobs remain identical to the first published head. Combined native pre-push tsc --noEmit/build PASS; modal-background-motion, window-sleep, window-a11y, all-theme-contrast, accounts-page and no-vacuous-waits passed 19 tests with two existing skips (61.818 seconds). The merged Accounts A4 correction, model-fit/disabled controls, all theme modes and window sleep behavior remain covered. No hardware performance claim.
