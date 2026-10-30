// Search bar: restaurants by name from Google, as you type.
//   place_search  Google Places Autocomplete near the map: food and drink places, then a few landmarks
//                 (a university, an airport, a hotel) to move the map to
//   place_get     the chosen one's location, type and rating (closes the autocomplete session)
// The app passes one session token per search so Google bills the typing and the final lookup as one.
// Pure logic with injected calls so it can be tested; index.ts wires it up.

export type SearchInput = { type: 'place_search'; q?: string; lat?: number; lng?: number; session?: string };
export type GetInput = { type: 'place_get'; id?: string; session?: string };
export type SearchHit = { google_place_id: string; name: string; detail: string; landmark?: boolean };
export type PlaceInfo = {
  google_place_id: string; name: string; address: string | null; lat: number | null; lng: number | null;
  categories: string[]; open: boolean; rating: number | null; review_count: number | null; price_level: string | null;
};

export type SearchDeps = {
  autocomplete: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  details: (id: string, session?: string) => Promise<Record<string, unknown> | null>;
};

const FOODISH = new Set(['restaurant', 'food', 'cafe', 'bar', 'bakery', 'meal_takeaway', 'meal_delivery', 'coffee_shop', 'ice_cream_shop', 'night_club', 'liquor_store', 'food_store']);

export function autocompleteBody(input: SearchInput) {
  const body: Record<string, unknown> = { input: (input.q ?? '').trim().slice(0, 100), languageCode: 'en' };
  if (input.session) body.sessionToken = input.session;
  if (typeof input.lat === 'number' && typeof input.lng === 'number') {
    body.locationBias = { circle: { center: { latitude: input.lat, longitude: input.lng }, radius: 50000 } };
    body.origin = { latitude: input.lat, longitude: input.lng };
  }
  return body;
}

export function parseAutocomplete(d: Record<string, unknown>): SearchHit[] {
  const food: SearchHit[] = [];
  const landmarks: SearchHit[] = [];
  for (const s of (d.suggestions as Record<string, unknown>[] | undefined) ?? []) {
    const p = s.placePrediction as Record<string, unknown> | undefined;
    if (!p?.placeId) continue;
    const types = (p.types as string[] | undefined) ?? [];
    const f = p.structuredFormat as { mainText?: { text?: string }; secondaryText?: { text?: string } } | undefined;
    const hit = {
      google_place_id: String(p.placeId),
      name: f?.mainText?.text ?? (p.text as { text?: string } | undefined)?.text ?? '',
      detail: f?.secondaryText?.text ?? '',
    };
    if (types.some((t) => FOODISH.has(t) || t.endsWith('_restaurant'))) food.push(hit);
    // a named place, not an address or a city (cities and neighborhoods come from the app's own lookup)
    else if (types.includes('establishment') || types.includes('point_of_interest')) landmarks.push({ ...hit, landmark: true });
  }
  return [...food.slice(0, 5), ...landmarks.slice(0, 3)];
}

export async function placeSearch(input: SearchInput, deps: SearchDeps): Promise<{ hits: SearchHit[] }> {
  if ((input.q ?? '').trim().length < 3) return { hits: [] };
  return { hits: parseAutocomplete(await deps.autocomplete(autocompleteBody(input)).catch(() => ({}))) };
}

export async function placeGet(input: GetInput, deps: SearchDeps): Promise<{ place: PlaceInfo | null }> {
  if (!input.id) return { place: null };
  const g = await deps.details(input.id, input.session).catch(() => null);
  if (!g?.id) return { place: null };
  const loc = (g.location ?? {}) as { latitude?: number; longitude?: number };
  return {
    place: {
      google_place_id: String(g.id),
      name: ((g.displayName as { text?: string } | undefined)?.text ?? '').trim(),
      address: (g.formattedAddress as string | undefined) ?? null,
      lat: loc.latitude ?? null,
      lng: loc.longitude ?? null,
      categories: (g.types as string[] | undefined) ?? [],
      open: ((g.businessStatus as string | undefined) ?? 'OPERATIONAL') === 'OPERATIONAL',
      rating: (g.rating as number | undefined) ?? null,
      review_count: (g.userRatingCount as number | undefined) ?? null,
      price_level: (g.priceLevel as string | undefined) ?? null,
    },
  };
}
