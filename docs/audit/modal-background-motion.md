# Modal background motion

Acceptance: decorative scenery keeps its last frame while first-run setup covers it or a dialog takes focus, resumes after the last covering overlay closes, and does not wake while hidden or resting. Dialog entrance/progress motion, OS reduced motion and Keep things still remain unchanged.

Implementation:
- `public/app/styles/modal-motion.css` pauses only `#bgLayer .paint11` under direct app setup/dialog overlays
- `public/app/shell/procbg.js` parks procedural drawing without scheduled callbacks while covered, hidden or resting. Drawing otherwise uses a frame-rate timer followed by one RAF, rather than calling RAF on every display frame even when no drawing is due
- `tests/modal-background-motion.test.mjs` covers the scheduler and real computed CSS behavior with synthetic DOM

Validation on 2026-10-01:
- Three deterministic scheduler tests passed, including multiple overlays, dismissal during hidden/resting states, duplicate wake prevention, disposal and frame-budget compensation
- JavaScript syntax and whitespace checks passed
- The original three-test suite passed in the native execution surface (system Chromium); the strengthened CSS phase-preservation assertion still needs a rerun after the current broad-suite lane finishes
- Independent review found no blockers for the narrow scope. Procedural position state is retained, but absolute-time firefly alpha can change phase on resume

Scope: this does not pause video/GIF scenery, avatars or pets. It does not establish a CPU, GPU-utilization, energy or battery improvement. The observed native OAuth-error high-CPU state needs an identical-build A/B with this patch and graphics status recorded, followed by hardware-accelerated Linux/Windows reproduction. The cloud GPU process can perform software rendering; process CPU is not GPU utilization.
