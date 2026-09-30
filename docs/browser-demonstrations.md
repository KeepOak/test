# Learn a browser workflow by demonstration

Take control of Branch's browser in a conversation and choose **Record demonstration**. Perform the journey in that tab, then choose **Preview demonstration** and **Save workflow**. Saving only stores the reviewed workflow. It never repeats the website actions.

The recorder grounds successful owner clicks in unique button/link names and typed text in unique field labels. It records the resulting field value, so consecutive typing becomes one fill. The workflow runs through `browser.flow`, with current tool, website, profile and approval rules checked before replay. A saved sign-in selected for the original browser is selected explicitly in the replay's own task. A workflow saved from a Trunk conversation belongs to that Trunk.

Record after signing in. Passwords, codes, credential-looking values, unsafe addresses, ambiguous targets, unsupported keyboard gestures and tab switching cannot become an automatic procedure. The preview explains omitted actions, and saving is refused if any are missing. Redaction placeholders are never replayed as text. The current implementation supports complete journeys of at most 12 semantic actions in one tab; it does not infer an arbitrary desktop workflow.

Recording requires the local owner's full window key and active browser control. It is bound to the conversation, tab, control epoch and window client. Preview freezes the recorded steps. Cancel, disconnect, handback, lock, control lease expiry and browser stop discard recordings. Unsaved recordings remain in memory for at most 30 minutes.

Verification: `node --test tests/browser-demonstrations.test.mjs tests/browser-control-api.test.mjs` uses isolated workspaces and real headless Chromium. It records human controls, saves, closes the original browser, replays in a fresh task, and checks changed policy blocks replay before navigation. It also covers profile continuity, private fields, ambiguous controls, forged scope and preview tokens.
