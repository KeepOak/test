import { z } from "zod";

export const Coordinate = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict();
export const MapsSettings = z.object({ enabled: z.boolean().default(false),
  termsAndBillingAccepted: z.boolean().default(false), keySecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  keyProject: z.string().min(1).max(100).optional(), maxCallsPerDay: z.number().int().min(1).max(100).default(10) }).strict();
export const MapsRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("places"), centre: Coordinate, radiusMeters: z.number().int().min(100).max(10000),
    category: z.enum(["catering.restaurant", "catering.cafe", "commercial.supermarket", "healthcare.pharmacy", "accommodation.hotel", "tourism.attraction"]),
    limit: z.number().int().min(1).max(10).default(5) }).strict(),
  z.object({ kind: z.literal("route"), origin: Coordinate, destination: Coordinate,
    mode: z.enum(["drive", "walk", "bicycle"]) }).strict(),
  z.object({ kind: z.literal("image"), centre: Coordinate, zoom: z.number().int().min(1).max(18).default(12) }).strict(),
]);
export type MapRequest = z.infer<typeof MapsRequest>;

/** Exact provider contract, fixed destinations, no remote URLs or IP/device geolocation. */
export function mapsURL(input: MapRequest): URL {
  if (input.kind === "places") {
    const url = new URL("https://api.geoapify.com/v2/places");
    url.search = new URLSearchParams({ categories: input.category, filter: `circle:${input.centre.longitude},${input.centre.latitude},${input.radiusMeters}`,
      limit: String(input.limit), lang: "en" }).toString();
    return url;
  }
  if (input.kind === "route") {
    const url = new URL("https://api.geoapify.com/v1/routing");
    url.search = new URLSearchParams({ waypoints: `${input.origin.latitude},${input.origin.longitude}|${input.destination.latitude},${input.destination.longitude}`,
      mode: input.mode, format: "geojson", units: "metric", details: "instruction_details" }).toString();
    return url;
  }
  const url = new URL("https://maps.geoapify.com/v1/staticmap");
  url.search = new URLSearchParams({ style: "osm-bright", width: "400", height: "300", format: "png",
    center: `lonlat:${input.centre.longitude},${input.centre.latitude}`, zoom: String(input.zoom), attribution: "default" }).toString();
  return url;
}

const Point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const Steps = z.object({ instruction: z.object({ text: z.string().max(500).optional() }).optional(),
  distance: z.number().nonnegative().optional(), time: z.number().nonnegative().optional() });
const Route = z.object({ type: z.literal("Feature"), geometry: z.object({ type: z.literal("MultiLineString"),
  coordinates: z.array(z.array(Point).max(5000)).max(2) }), properties: z.object({ distance: z.number().nonnegative(),
  distance_units: z.string().max(30), time: z.number().nonnegative(), legs: z.array(z.object({ steps: z.array(Steps).max(300) })).max(2).optional() }) });
const Place = z.object({ type: z.literal("Feature"), geometry: z.object({ type: z.literal("Point"), coordinates: Point }),
  properties: z.object({ place_id: z.string().max(500), name: z.string().max(200).optional(), formatted: z.string().max(500).optional(),
    categories: z.array(z.string().max(100)).max(30).optional() }) });

export function mapsJSON(input: MapRequest, raw: string, secret: string) {
  // Strip key echoes before validated whitelist fields can reach a task, its history or the window.
  const data: unknown = JSON.parse(raw.replaceAll(secret, "[redacted]"));
  if (input.kind === "places") return z.object({ type: z.literal("FeatureCollection"), features: z.array(Place).max(10) }).parse(data);
  const answer = z.object({ type: z.literal("FeatureCollection"), features: z.array(Route).max(1) }).parse(data);
  return answer;
}
