# Isolated household gateways (PLAT-184)

This opt-in owner API starts a separate worker and loopback gateway for an existing household profile. The original logical profile, its PIN, its conversations and the original Store remain intact. Nothing starts automatically.

Use the authenticated local window's API key. Paired doors and short-lived script keys are refused. Replace `PROFILE_ID` with the existing household UUID:

1. `GET /api/profile-gateways/PROFILE_ID` reviews whether a gateway exists and its live worker status.
2. `POST /api/profile-gateways/PROFILE_ID` with `{"credentials":"fresh","history":"keep-in-original","sharing":"none"}` creates its immutable binding. This is the only supported migration choice; it copies nothing.
3. `POST /api/profile-gateways/PROFILE_ID/start` starts the isolated worker. Check its status before routing requests. `POST .../stop` drains and stops it.
4. `POST .../route` with `{"operation":"configure-model","settings":{...}}` uses the existing `/api/models` settings contract to configure credentials explicitly in the new Store. Only the owner can do this. Existing owner tokens are never copied.
5. Route `{"operation":"sessions"}`, `{"operation":"read","sessionId":"UUID"}`, or `{"operation":"run","prompt":"...","sessionId":"UUID"}` (sessionId optional for a new conversation). Responses contain the profile ID and isolated result. The owner or that selected profile may use these operations. A session must resolve inside that exact child; requests never fall back to the original Store. Root session IDs, model settings and project options are not implicitly forwarded.

Each binding lives under `DATA_HOME/profile-gateways/UUID/`: a separate `data/branch.sqlite`, locker key, session key, config, memory and workspace. HOME, USERPROFILE, APPDATA, LOCALAPPDATA and temporary directories belong to the new home. Workers receive an allowlist of basic OS environment variables, not parent PATH, provider keys, OAuth tokens, integrations or the desktop credential bridge. The existing gateway manages worker restarts and stops orphan workers on IPC disconnect. SQLite's existing exclusive writer lock remains in force, alongside an atomic supervisor lease.

A crash can leave `writer.lock`. It is deliberately not stolen automatically. After stopping Branch and verifying that no isolated child is alive, the owner can review its `owner.json` PID and remove only that specific lease directory. No recovery, export, credential sharing or history migration runs as part of this API. Reusing an existing binding keeps its own saved settings; creation refuses overwrite.

This is process and data isolation within the same OS account, not protection from a hostile same-user process. Use separate OS users for that stronger boundary. Desktop Settings integration and automatic selection-to-gateway switching are follow-up UX work; the explicit API supplies operational routing today.

Design reference: [Hermes profiles](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md) and [multiple profile gateways](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/multi-profile-gateways.md). This implementation uses Branch's own household identity, exclusive Store locking and gateway lifecycle; no upstream code was copied.
