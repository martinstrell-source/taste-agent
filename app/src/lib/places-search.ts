// City and neighborhood suggestions while typing, from Photon (OpenStreetMap data; free, no key).
// Fine for testing and modest use; switch to Google's suggestions when the app moves to a Google map.

export type Suggestion = { key: string; label: string; detail: string; lat: number; lng: number; kind: string };

type Feature = {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | number | undefined>;
};

export function parsePhoton(json: { features?: Feature[] }): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const f of json.features ?? []) {
    const c = f.geometry?.coordinates;
    const p = f.properties ?? {};
    const name = typeof p.name === 'string' ? p.name : '';
    if (!c || !name) continue;
    // "Rockridge" -> "Oakland, California"; "Lisbon" -> "Portugal"
    const parts = [p.city, p.county, p.state, p.country]
      .filter((x): x is string => typeof x === 'string' && x !== name);
    const detail = [...new Set(parts)].slice(0, 2).join(', ');
    const key = `${name}|${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: name,
      detail,
      lat: c[1],
      lng: c[0],
      kind: String(p.osm_value ?? p.type ?? ''),
    });
  }
  return out;
}

export async function suggestPlaces(q: string, near?: { lat: number; lng: number }, signal?: AbortSignal): Promise<Suggestion[]> {
  const params = new URLSearchParams({ q, limit: '6', lang: 'en' });
  for (const layer of ['city', 'district', 'locality', 'county']) params.append('layer', layer);
  if (near) {
    params.set('lat', String(near.lat));
    params.set('lon', String(near.lng));
  }
  const r = await fetch(`https://photon.komoot.io/api/?${params}`, { signal });
  if (!r.ok) return [];
  return parsePhoton(await r.json());
}
