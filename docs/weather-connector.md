# City weather (RES-124)

Settings › Accounts enables a concrete Open-Meteo connector, off by default. Free access requires acknowledgement of non-commercial-only terms. Commercial access requires the owner's existing customer plan, explicit terms/billing acknowledgement and the name of a key already in that project's locker. Configuring this connector creates no subscription and performs no key resolution or API call. Consent stays on this computer and does not travel through backups/restores.

Customer mode uses `customer-geocoding-api.open-meteo.com` and `customer-api.open-meteo.com` with the documented `apikey` parameter, resolved from the chosen project's existing secret transport only when the owner requests weather. It refuses missing credentials and never falls back to public non-commercial endpoints. Keys are stripped from returned source URLs and provider echoes, and transport errors are generic. Plan validity, entitlement, quota and billing are unknown; configuring a key is not evidence of a commercial licence or invoice total. The owner must maintain their existing eligible provider subscription. No paid call was made in this delivery.

The actual registered `weather.forecast` tool takes a city name, ISO two-letter country and 1–7 days. It refuses delegated, scheduled, channel and other non-owner work. The existing owner guard, runtime tool policies, Lockdown and outbound network policy still apply. The Accounts request button uses `runtime.executeTool`, not an alternate HTTP bypass. It asks before sending the typed city.

Geocoding requests five candidates from the official endpoint, filters country and populated-place feature codes, and refuses ambiguity rather than guessing. Only the unique provider city centre is sent to the forecast endpoint. No latitude/longitude input, GPS, IP geolocation, postal-code input or device-location authority exists here. A city centre is not the owner's precise location. Locations and forecast grids returned by the provider remain untrusted information.

The reader requests Celsius daily maximum/minimum temperature, precipitation in mm, and numeric WMO weather codes. Responses have strict field/length validation, a 64 KiB cap, a shared 20-second deadline, cancellation, no redirects and no retries. One forecast can make at most two HTTP attempts, with one in flight and ten seconds between requests. A persisted local UTC-day counter defaults to ten HTTP attempts (configurable 1–100 through the validated owner configuration); refused/failed attempts still count. This is not an account-wide quota or money guarantee. Locking or changing permissions aborts active calls. Null values remain missing, mismatched or truncated series are refused. Output retains attribution, source URL, provider grid/timezone and read time; model issue time is unknown. Forecasts are not verified observations or travel/safety advice. Ordinary task results may enter that owner's history as existing web reads do.

Existing `web.search` already supports DuckDuckGo, SearXNG, Brave, Tavily, Exa and Serper; it is not duplicated. [Maps, routes and POIs](maps-connector.md) use a separate concrete Geoapify connector. Street weather geocoding, live observations and automatic location selection remain unsupported. The catalogue's weather entry and Seasons PR #932 are not provider integrations. No app, test, build or provider request was executed in this delivery; wire interoperability remains unverified.

Primary contracts reviewed:

- [Forecast API](https://open-meteo.com/en/docs)
- [Geocoding API](https://open-meteo.com/en/docs/geocoding-api)
- [Terms/privacy](https://open-meteo.com/en/terms): free API non-commercial only; request logs may contain coordinates and be retained for 90 days.
- [Data licence](https://open-meteo.com/en/licence): Open-Meteo CC BY 4.0, GeoNames attribution retained.
- [Customer pricing/endpoint contract](https://open-meteo.com/en/pricing)
- [OpenClaw weather skill](https://github.com/openclaw/openclaw/blob/main/skills/weather/SKILL.md), referenced by RES-124, is precedent only. No upstream code was copied or new dependency added.
