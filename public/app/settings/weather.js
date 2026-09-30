import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { ownerHere } from "../core/state.js";

export function weatherSection() {
  return `<div class="sec"><h2>City weather</h2><p class="hint">Open-Meteo is off until you enable it. Free API: non-commercial use only. Commercial use: configure your existing paid customer plan and a locker secret name; no subscription is created. Billing and remaining provider quota are unknown. Requests share your typed city/country and provider city centre; logs may retain coordinates for 90 days. No device location is collected. Default local cap: ten HTTP attempts per UTC day, up to two per forecast.</p>
    <button class="btn" type="button" data-act="weather-settings">Enable or disable weather</button>
    <button class="btn" type="button" data-act="weather-city">Get a city forecast</button>
    <pre id="weather-result" style="white-space:pre-wrap"></pre>
    <a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> · <a href="https://open-meteo.com/en/terms" target="_blank" rel="noopener">Provider terms</a> · <a href="https://open-meteo.com/en/licence" target="_blank" rel="noopener">Open-Meteo / GeoNames attribution</a></div>`;
}
on("weather-settings", async () => {
  if (!ownerHere()) return;
  try {
    const current = await api("weather");
    if (!ownerHere()) return;
    if (current.settings.enabled) {
      await api("weather", { ...current.settings, enabled: false });
      if (ownerHere()) toast("Weather disabled"); return;
    }
    const access = prompt("Type non-commercial for the free API, or customer for your existing commercial Open-Meteo plan", "non-commercial");
    if (!["non-commercial", "customer"].includes(access)) return;
    const keySecret = access === "customer" ? prompt("Name of the existing Open-Meteo customer API key in this project's locker (never paste the key here)", "OPEN_METEO_CUSTOMER_KEY") : undefined;
    if (access === "customer" && !keySecret) return;
    if (!confirm(`Enable ${access} weather? I accept the selected provider terms and location disclosure. ${access === "customer" ? "I have an existing commercial plan; its billing/remaining quota are unknown and this creates no subscription." : "I will use the free service only for non-commercial purposes."} Provider logs may retain coordinates for 90 days. Ten HTTP attempts per UTC day; up to two per forecast. Retain CC BY 4.0 attribution.`) || !ownerHere()) return;
    await api("weather", { enabled: true, access, keySecret, nonCommercialTermsAccepted: access === "non-commercial", customerPlanAccepted: access === "customer", maxCallsPerDay: 10 });
    if (ownerHere()) toast(`Weather enabled: ${access}`);
  } catch (error) { if (ownerHere()) toast(error.message); }
});
on("weather-city", async () => {
  if (!ownerHere()) return;
  const city = prompt("City name (no address or coordinates)");
  if (!city) return;
  const country = prompt("Two-letter country code, e.g. US or GB");
  if (!country || !ownerHere()) return;
  if (!confirm(`Send ${city}, ${country.toUpperCase()} to Open-Meteo for a three-day forecast?`)) return;
  try {
    const answer = await api("weather/forecast", { city, country: country.toUpperCase(), days: 3 });
    if (!ownerHere()) return;
    const output = document.getElementById("weather-result");
    if (output) output.textContent = JSON.stringify(answer, null, 2);
  } catch (error) { if (ownerHere()) toast(error.message); }
});
