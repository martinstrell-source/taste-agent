import { supabase, type NearbyPlace } from './supabase';

// Search bar: your own saved places by name (instant, from the database) and restaurants from Google
// (through the capture function, so the key stays on the server).

export type GoogleHit = { google_place_id: string; name: string; detail: string; landmark?: boolean }; // landmark: not food, a place to go to
type Near = { lat: number; lng: number } | null | undefined;

export async function searchSaves(q: string, near: Near): Promise<NearbyPlace[]> {
  const { data, error } = await supabase.rpc('search_saves', { q, lat: near?.lat ?? null, lng: near?.lng ?? null });
  if (error) return []; // not deployed yet: no saved results
  return ((data ?? []) as Omit<NearbyPlace, 'kind' | 'note'>[]).map((r) => ({ ...r, kind: 'saved', note: null, distance_m: r.distance_m ?? 0 }));
}

// one token per search, so Google bills the typing and the final lookup together
export function newSession(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export async function searchGoogle(q: string, near: Near, session: string): Promise<GoogleHit[]> {
  const { data, error } = await supabase.functions.invoke('capture', { body: { type: 'place_search', q, session, ...(near ?? {}) } });
  if (error) return [];
  return (data?.hits ?? []) as GoogleHit[];
}

// the chosen Google result as a card-ready place (shown like a pick, labeled "Search result")
export async function googlePlace(id: string, session: string, near: Near): Promise<NearbyPlace | null> {
  const { data, error } = await supabase.functions.invoke('capture', { body: { type: 'place_get', id, session } });
  const p = data?.place;
  if (error || !p || p.lat == null || p.lng == null) return null;
  const R = 6371000;
  const rad = Math.PI / 180;
  const dist = near
    ? 2 * R * Math.asin(Math.sqrt(Math.sin(((p.lat - near.lat) * rad) / 2) ** 2 + Math.cos(near.lat * rad) * Math.cos(p.lat * rad) * Math.sin(((p.lng - near.lng) * rad) / 2) ** 2))
    : 0;
  return {
    kind: 'pick',
    from_search: true,
    ref: p.google_place_id,
    google_place_id: p.google_place_id,
    name: p.name,
    address: p.address,
    place_lat: p.lat,
    place_lng: p.lng,
    distance_m: dist,
    categories: p.categories,
    list_name: null,
    note: null,
    rating: p.rating,
    review_count: p.review_count,
    price_level: p.price_level,
  };
}
