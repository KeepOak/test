// RES-124: weather ships off; once the owner turns it on and accepts the non-commercial terms, a named city gets a
// forecast from Open-Meteo through the network policy; an ambiguous city fetches no forecast. Stand-in answers only.
import test from "node:test";
import assert from "node:assert/strict";
import { WeatherAccess } from "../dist/integrations/weather.js";

function store() {
  const rows = new Map();
  return { get: (_t, _o, id) => rows.get(id), save: (_t, _o, id, data) => rows.set(id, { id, data }), profiles: { requireOwner() {} } };
}
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const lyon = { id: 1, name: "Lyon", country_code: "FR", latitude: 45.75, longitude: 4.85, feature_code: "PPLA", admin1: "Auvergne" };
const daily = { time: ["2026-09-30", "2026-10-01"], temperature_2m_max: [20, null], temperature_2m_min: [10, 9], precipitation_sum: [0, 1.5], weather_code: [1, 61] };

test("off by default, terms before on, then a city's forecast with its source; an ambiguous city fetches nothing", async () => {
  const asked = [];
  let geocode = { results: [lyon] };
  const fetch = async (url) => { asked.push(new URL(url).hostname);
    return new URL(url).hostname.startsWith("geocoding") ? json(geocode)
      : json({ latitude: 45.76, longitude: 4.84, timezone: "Europe/Paris", daily_units: { temperature_2m_max: "°C", temperature_2m_min: "°C", precipitation_sum: "mm" }, daily }); };
  const weather = new WeatherAccess(store(), "owner", { policy: { guard: () => fetch } });
  assert.equal(weather.settings().enabled, false);
  await assert.rejects(weather.forecast({ city: "Lyon", country: "FR", days: 2 }, new AbortController().signal), /Weather is off/);
  assert.throws(() => weather.configure({ enabled: true }), /non-commercial/);
  weather.configure({ enabled: true, nonCommercialTermsAccepted: true });
  const got = await weather.forecast({ city: "Lyon", country: "FR", days: 2 }, new AbortController().signal);
  assert.equal(got.status, "forecast");
  assert.deepEqual(got.forecast.daily.temperature_2m_max, [20, null], "a missing value stays missing");
  assert.match(got.attribution, /Open-Meteo/);
  assert.deepEqual(asked, ["geocoding-api.open-meteo.com", "api.open-meteo.com"]);
  await assert.rejects(weather.forecast({ city: "45.7,4.8", country: "FR" }, new AbortController().signal), /city name/);
  geocode = { results: [lyon, { ...lyon, id: 2, admin1: "Elsewhere" }] };
  const other = new WeatherAccess(store(), "owner", { policy: { guard: () => fetch } });
  other.configure({ enabled: true, nonCommercialTermsAccepted: true });
  asked.length = 0;
  assert.equal((await other.forecast({ city: "Lyon", country: "FR" }, new AbortController().signal)).status, "choose-a-city");
  assert.deepEqual(asked, ["geocoding-api.open-meteo.com"], "no forecast fetched for an ambiguous city");
});
