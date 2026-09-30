# City weather (RES-124, partial)

Settings › Accounts enables a concrete Open-Meteo connector, off by default. The owner acknowledges the free API's non-commercial terms and location disclosure before enabling. No subscription, credential, paid API, background job or location discovery is started. Consent stays on this computer and does not travel through backups/restores.

The actual registered `weather.forecast` tool takes a city name, ISO two-letter country and 1–7 days. It refuses delegated, scheduled, channel and other non-owner work. The existing owner guard, runtime tool policies, Lockdown and outbound network policy still apply. The Accounts request button uses `runtime.executeTool`, not an alternate HTTP bypass. It asks before sending the typed city.

Geocoding requests five candidates from the official endpoint, filters country and populated-place feature codes, and refuses ambiguity rather than guessing. Only the unique provider city centre is sent to the forecast endpoint. No latitude/longitude input, GPS, IP geolocation, postal-code input or device-location authority exists here. A city centre is not the owner's precise location. Locations and forecast grids returned by the provider remain untrusted information.

The reader requests Celsius daily maximum/minimum temperature, precipitation in mm, and numeric WMO weather codes. Responses have strict field/length validation, a 64 KiB cap, a shared 20-second deadline, cancellation, no redirects and no retries. One request can make at most two calls, with one in flight and ten seconds between requests per app instance. This is not an account-wide quota guarantee. Null values remain missing, mismatched or truncated series are refused. Output retains attribution, source URL, provider grid/timezone and read time; model issue time is unknown. Forecasts are not verified observations or travel/safety advice. Ordinary task results may enter that owner's history as existing web reads do.

Existing `web.search` already supports DuckDuckGo, SearXNG, Brave, Tavily, Exa and Serper; it is not duplicated. Maps, routing, POIs, street geocoding, commercial weather access, live observations and automatic location selection remain gaps. The catalogue's weather entry and Seasons PR #932 are not provider integrations. No app, test, build or provider request was executed in this delivery; wire interoperability remains unverified.

Primary contracts reviewed:

- [Forecast API](https://open-meteo.com/en/docs)
- [Geocoding API](https://open-meteo.com/en/docs/geocoding-api)
- [Terms/privacy](https://open-meteo.com/en/terms): free API non-commercial only; request logs may contain coordinates and be retained for 90 days.
- [Data licence](https://open-meteo.com/en/licence): Open-Meteo CC BY 4.0, GeoNames attribution retained.
- [OpenClaw weather skill](https://github.com/openclaw/openclaw/blob/main/skills/weather/SKILL.md), referenced by RES-124, is precedent only. No upstream code was copied or new dependency added.
