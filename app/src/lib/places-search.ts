// City and neighborhood suggestions while typing, from Photon (OpenStreetMap data; free, no key).
// Fine for testing and modest use; switch to Google's suggestions when the app moves to a Google map.

export type Suggestion = { key: string; label: string; detail: string; lat: number; lng: number; kind: string };

type Feature = {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | number | undefined>;
};

// lowercase words without accents: "São Paulo" -> ["sao", "paulo"]
const words = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// every word typed has to start a word in the result: Photon matches loosely ("University of pennsy"
// otherwise brings back the University of British Columbia)
export function matchesTyped(q: string, text: string): boolean {
  const have = words(text);
  return words(q).every((w) => have.some((h) => h.startsWith(w)));
}

export function parsePhoton(json: { features?: Feature[] }, q = ''): Suggestion[] {
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
    if (q && !matchesTyped(q, `${name} ${parts.join(' ')}`)) continue;
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
  const params = new URLSearchParams({ q, limit: '10', lang: 'en' }); // extra, since loose matches are dropped
  for (const layer of ['city', 'district', 'locality', 'county']) params.append('layer', layer);
  if (near) {
    params.set('lat', String(near.lat));
    params.set('lon', String(near.lng));
  }
  const r = await fetch(`https://photon.komoot.io/api/?${params}`, { signal });
  if (!r.ok) return [];
  return parsePhoton(await r.json(), q).slice(0, 6);
}
