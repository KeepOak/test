# Branch Agent — the web API

Written by `node scripts/write-api-docs.mjs` from the app's own input checks. Do not edit by hand.

Branch Agent's own web API. It runs on this computer only, and every request carries the session key the app printed when it started.

Version 0.19.3. The machine-readable description is at `GET /api/openapi.json`.

## runs

| Method | Address | What it is for |
| --- | --- | --- |
| `POST` | `/api/run` | Carry out one task and wait for the answer. |
| `GET` | `/api/runs/{runId}` | One task: what happened, what it said, and what it cost. |
| `GET` | `/api/runs/{runId}/inspect` | Look inside a task: rounds, tool calls, plan and verdicts. |
| `GET` | `/api/activity` | Tasks working now and the conversations they belong to. |
## sessions

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/sessions/{sessionId}` | One conversation with its messages. |
| `GET` | `/api/sessions/{sessionId}/tree` | This conversation and everything branched from it. |
| `POST` | `/api/sessions/{sessionId}/merge-note` | Carry this branch's last answer back into the conversation it came off. |
| `POST` | `/api/goals` | Keep working in rounds until a goal is judged met (goal mode must be switched on). |
| `GET` | `/api/goal-undo/settings` | The off, on and when-needed switches for goal mode and rewind snapshots. |
| `POST` | `/api/goal-undo/settings` | Change either switch; the one not sent keeps its value. |
| `GET` | `/api/sessions/{sessionId}/goal` | The goal in this conversation: round, score, what is missing, time. |
| `POST` | `/api/sessions/{sessionId}/goal` | Pause, resume or stop this conversation's goal. |
| `GET` | `/api/sessions/{sessionId}/rewind` | Whether files can be taken back here, and the rewind that can be undone. |
| `POST` | `/api/sessions/{sessionId}/rewind` | Take the conversation, the files, or both back to just before one message. |
| `POST` | `/api/sessions/{sessionId}/unrevert` | Undo the newest rewind in this conversation. |
| `GET` | `/api/sessions/{sessionId}/goal/undo` | What undoing this conversation's goal would put back: its files, its drafts and its facts. |
| `POST` | `/api/sessions/{sessionId}/goal/undo` | Undo the goal: stop it, put back its files, delete its drafts and forget what it learned. The conversation stays. |
## memory

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/memory/export` | Everything the assistant has been asked to remember. |
| `POST` | `/api/memory/search` | Search the saved facts. |
## app

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/state` | One snapshot of everything the app's own screen shows. |
| `GET` | `/api/health` | Whether the app, its database and its model connection are well. |
| `GET` | `/api/openapi.json` | This description. |
## tools

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/tools` | Every tool the assistant has, with what each one needs. |
## projects

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/projects` | The projects work is grouped under. |
| `POST` | `/api/projects` | Save a project. |
| `POST` | `/api/projects/new` | Make a project; an id already in use is refused. |
## flows

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/flows` | Saved flows as boxes and arrows. |
| `POST` | `/api/flows` | Save a flow. |
| `POST` | `/api/flows/{flowId}/run` | Start a saved flow. |
| `GET` | `/api/flows/{flowId}/yaml` | One saved flow written as YAML (building on Branch must be switched on). |
| `POST` | `/api/flows/yaml` | Save a flow written as YAML, always as a new flow (building on Branch must be switched on). |
## developer

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/sdk-kit` | The switch for building on Branch, the clients for each language, and the tools to share. |
| `POST` | `/api/sdk-kit` | Change that switch (the owner only). |
## settings

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/policy` | The approval settings. |
| `POST` | `/api/policy` | Change the approval settings. |
| `GET` | `/api/lockdown` | Whether Lockdown is on. |
| `POST` | `/api/lockdown` | Turn Lockdown on or off. |
## commands

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/commands` | The typed commands one page offers; add ?surface=window, phone or dashboard. |
| `GET` | `/api/commands/table` | Every typed command on every surface, and how each compares with other assistants. |
| `POST` | `/api/commands/run` | Carry out one typed command; a key that may only look may send only commands that look. |
| `GET` | `/api/commands/settings` | The off, on and when-needed switch for the commands the table added. |
| `POST` | `/api/commands/settings` | Change that switch (the key of this computer only). |
## dashboard

| Method | Address | What it is for |
| --- | --- | --- |
| `GET` | `/api/dashboard` | The browser dashboard in one answer: what is happening now, health, spending and recent activity (the dashboard must be switched on). |
| `GET` | `/api/dashboard/settings` | The dashboard's switch, and what this key may do there. |
| `POST` | `/api/dashboard/settings` | Switch the dashboard (the key of this computer only). |
| `GET` | `/api/dashboard/automations` | What Pause all paused, or null (the key of this computer only; answered whether or not the dashboard is switched on). |
| `POST` | `/api/dashboard/automations` | Pause every schedule and trigger, or resume the ones that were paused (the key of this computer only). |
| `POST` | `/api/dashboard/restart` | Restart Branch, where the computer's own service will start it again (the key of this computer only). |
## compatibility

| Method | Address | What it is for |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | The OpenAI-shaped way in, for tools that already speak it. |
| `GET` | `/v1/models` | The model connections, in the OpenAI shape. |
