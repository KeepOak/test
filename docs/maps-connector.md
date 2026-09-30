# Maps, routes and POIs (RES-124)

This follows city-weather PR #1227 with an actual Geoapify connector and commercial Open-Meteo configuration. Existing Branch MCP support connects explicitly configured servers through validated schemas and selected tools; the `maps` catalogue row is a description, not an installed server or an implemented provider. No existing Geoapify connector/open PR was found. OpenAPI/MCP transports remain available for other owner-selected providers; no duplicate web-search implementation or dependency is added.

Accounts enables Geoapify only after the owner names a key in the existing active project's locker, acknowledges their existing plan's terms/commercial eligibility, location disclosure and unknown billing, and chooses a local HTTP attempt cap (default ten; maximum 100 per UTC day). The key remains in that project's existing secret transport. Enabling/configuring resolves no key, subscribes to nothing and performs no provider call. Settings/consent and the local counter do not travel through backups/restores. A key's presence is not proof of a plan, current quota, commercial entitlement or invoice amount. The free package has limited production commercial eligibility; the owner must check their actual provider contract.

The owner enters exact coordinates in the local Accounts window, selects scope and sees a complete JSON preview. Approval records one immutable request in memory, valid for three minutes and one use. No GPS, IP/device geolocation, background tracking or coordinate inference exists. `POST /api/maps/authorize` is restricted to the unlocked local owner window, excluding paired/remote doors, people and short-lived keys. It requires explicit coordinate-entry and single-call billing acknowledgements. A request can be fetched immediately through the existing `runtime.executeTool` gate, or its exact tool/request ID can be given manually to an original private owner task. It is never sent automatically to a conversation.

Actual registered tools are `maps.places`, `maps.route` and `maps.image`. Their only argument is the owner-prepared `requestId`; a model cannot supply alternative coordinates, URL, radius, mode or scope. The original task/source/profile/permissions and network rules still apply. Delegated, shared, temporary, lent, channel, other-profile and key work is refused. Policy targets show the key-free exact provider URL/coordinates and unknown billing. The request is consumed before secret resolution/outbound work; failure/timeout never replays it. Owner disable/revoke and app lock clear pending requests and abort active calls. Settings are rechecked before/after requests, and task privacy is checked again before returning results.

Supported provider scope:

- Places: six documented categories, an explicitly supplied centre, 100–10,000 metre circle and up to ten results. This is bounded provider POI coverage, never an exhaustive or live open/closed inventory.
- Routes: one origin/destination pair, drive/walk/bicycle, metric distance, estimated seconds, bounded GeoJSON geometry and turn instructions. No live traffic, transit, multi-stop optimization, offline navigation or guarantee of legal/current access.
- Maps: one 400×300 PNG at an approved centre/zoom. The backend fetches and validates it; the UI displays a bounded data URL, never the authenticated provider URL. Default provider/data attribution remains visible. This is an actual static map, not an interactive tile browser or a route overlay.

Each operation makes one fixed-endpoint HTTP attempt. Calls have a shared 20-second deadline, cancellation, no redirects/retries, one in flight, and ten seconds between attempts. Caps are 256 KiB for the image and 512 KiB for JSON, with independent schema/feature/geometry/step limits. Missing or incompatible fields and oversized results are refused. Empty features are no result. Key echoes are stripped and unknown raw JSON fields are discarded. Read time and source are returned; dataset update time, completeness, provider quota and billed amount remain unknown. Ordinary explicitly requested results may enter the original owner's task/history under existing read behavior; there is no separate location cache or scheduled sync.

Attribution is retained in the image, output and visible UI: Geoapify, OpenStreetMap contributors/ODbL and OpenMapTiles. Provider text, geometry and images are external information, never assistant instructions. No upstream implementation was copied.

Primary contracts reviewed:

- [Geoapify places API](https://apidocs.geoapify.com/docs/places/)
- [Geoapify routing API](https://apidocs.geoapify.com/docs/routing/)
- [Geoapify static maps API and attribution](https://apidocs.geoapify.com/docs/maps/static/)
- [Geoapify terms](https://www.geoapify.com/terms-and-conditions/), [privacy](https://www.geoapify.com/privacy-policy/)
- [OpenClaw goplaces](https://github.com/openclaw/openclaw/blob/main/skills/goplaces/SKILL.md), [Hermes maps](https://github.com/NousResearch/hermes-agent/blob/main/skills/productivity/maps/SKILL.md) are requirement references, not copied code or an installed runtime.

Tests: `tests/maps-connector.test.mjs` (ships off, exact single-use approval). Live Geoapify calls, provider plans and the Accounts form are not exercised by tests.
