import { supabase, type NearbyPlace } from './supabase';

// Starred saves: by row id and by Google place (a place saved twice shows once, under either copy)
export type Starred = { ids: Set<string>; gids: Set<string> };
export const NO_STARS: Starred = { ids: new Set(), gids: new Set() };

export async function fetchStarred(): Promise<Starred> {
  const { data, error } = await supabase.from('places').select('id, google_place_id').not('starred_at', 'is', null);
  if (error) return NO_STARS; // column not added yet (deploy.sh not run): no stars
  return {
    ids: new Set((data ?? []).map((r) => String(r.id))),
    gids: new Set((data ?? []).map((r) => r.google_place_id).filter(Boolean) as string[]),
  };
}

export function isStarred(p: NearbyPlace, s: Starred): boolean {
  return p.kind === 'saved' && (s.ids.has(p.ref) || (!!p.google_place_id && s.gids.has(p.google_place_id)));
}

// star or unstar every copy of the place
export async function setStar(p: NearbyPlace, on: boolean): Promise<void> {
  const q = supabase.from('places').update({ starred_at: on ? new Date().toISOString() : null });
  const { error } = p.google_place_id ? await q.eq('google_place_id', p.google_place_id) : await q.eq('id', Number(p.ref));
  if (error) throw new Error(/starred_at/.test(error.message) ? 'Stars need the latest database update (run deploy.sh).' : error.message);
}
