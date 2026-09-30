import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { ownerHere } from "../core/state.js";

export function weatherSection() {
  return `<div class="sec"><h2>City weather</h2><p class="hint">Open-Meteo is off until you enable it. The free API permits non-commercial use only. Requests share your typed city/country and provider city centre; the provider may retain request logs for 90 days. No device or precise location is collected. No routes or map search.</p>
    <button class="btn" type="button" data-act="weather-settings">Enable or disable weather</button>
    <button class="btn" type="button" data-act="weather-city">Get a city forecast</button>
    <pre id="weather-result" style="white-space:pre-wrap"></pre>
    <a href="https://open-meteo.com/en/terms" target="_blank" rel="noopener">Provider terms</a> · <a href="https://open-meteo.com/en/licence" target="_blank" rel="noopener">Open-Meteo / GeoNames attribution</a></div>`;
}
on("weather-settings", async () => {
  if (!ownerHere()) return;
  try {
    const current = await api("weather");
    if (!ownerHere()) return;
    const enabled = !current.settings.enabled;
    if (enabled && !confirm("Enable for non-commercial use only? City requests go to Open-Meteo. Its logs may retain coordinates for 90 days. Data is CC BY 4.0; retain attribution. This does not enable paid or precise-location access.")) return;
    await api("weather", { enabled, nonCommercialTermsAccepted: enabled });
    if (ownerHere()) toast(enabled ? "Weather enabled for non-commercial city requests" : "Weather disabled");
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
