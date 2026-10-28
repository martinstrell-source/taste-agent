import { supabase, type NearbyPlace } from './supabase';

export type HideReason = 'closed' | 'didnt_like';
export type HiddenPlace = { id: number; googleId: string | null; name: string; reason: HideReason; hidden_at: string };

// What to undo: the place row, plus the visit and reaction written for "didn't like it"
export type HideReceipt = { placeId: number; placeGoogleId: string | null; visitId: number | null; googleId: string | null; reason: HideReason };

const NEEDS_SCHEMA = 'Hiding places needs schema_v4.sql to be run in Supabase first.';
const NEEDS_V5 = 'Moving places between lists needs schema_v5.sql to be run in Supabase first.';

// A place can be saved more than once (on two lists, or twice on one). Changes apply to every copy:
// all rows with the same Google place, or just this row when it has no Google match.
function samePlace<T extends { eq: (col: string, v: string | number) => T }>(q: T, p: { ref: string; google_place_id?: string | null }): T {
  return p.google_place_id ? q.eq('google_place_id', p.google_place_id) : q.eq('id', Number(p.ref));
}

async function userId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('Not signed in');
  return data.user.id;
}

// "Closed" hides a saved place (it still counts toward taste).
// "Didn't like it" hides it and records a visit with reaction "no", plus a "no" reaction so
// picks avoid similar places.
export async function hidePlace(p: NearbyPlace, reason: HideReason): Promise<HideReceipt> {
  const placeId = Number(p.ref);
  const { error } = await samePlace(
    supabase.from('places').update({ hidden_at: new Date().toISOString(), hidden_reason: reason }),
    p,
  );
  if (error) throw new Error(/hidden/.test(error.message) ? NEEDS_SCHEMA : error.message);
  let visitId: number | null = null;
  const googleId = p.google_place_id ?? null;
  if (reason === 'didnt_like') {
    const uid = await userId();
    const v = await supabase
      .from('visits')
      .insert({ user_id: uid, place_id: placeId, google_place_id: googleId, reaction: 'no' })
      .select('id')
      .single();
    visitId = v.data?.id ?? null;
    if (googleId) {
      await supabase
        .from('feedback')
        .upsert({ user_id: uid, google_place_id: googleId, name: p.name, reaction: 'no' }, { onConflict: 'user_id,google_place_id' });
    }
  }
  return { placeId, placeGoogleId: googleId, visitId, googleId: reason === 'didnt_like' ? googleId : null, reason };
}

export async function undoHide(r: HideReceipt): Promise<void> {
  await restorePlace(r.placeId, r.placeGoogleId);
  if (r.visitId) await supabase.from('visits').delete().eq('id', r.visitId);
  if (r.googleId) await supabase.from('feedback').delete().eq('google_place_id', r.googleId).eq('reaction', 'no');
}

export async function restorePlace(placeId: number, googleId: string | null = null): Promise<void> {
  const { error } = await samePlace(
    supabase.from('places').update({ hidden_at: null, hidden_reason: null }),
    { ref: String(placeId), google_place_id: googleId },
  );
  if (error) throw new Error(error.message);
}

// Move a saved place to Favorites or Want to go. Marked as set in the app, so a later
// Google Takeout import doesn't move it back.
export async function moveToList(p: NearbyPlace, list: 'favorites' | 'want_to_go'): Promise<void> {
  const { error } = await samePlace(
    supabase.from('places').update({ list_name: list, list_set_in_app: true }),
    p,
  );
  if (error) throw new Error(/list_set_in_app/.test(error.message) ? NEEDS_V5 : error.message);
}

export async function listHidden(): Promise<HiddenPlace[]> {
  const { data, error } = await supabase
    .from('places')
    .select('id, google_place_id, title, google_name, hidden_reason, hidden_at')
    .not('hidden_at', 'is', null)
    .order('hidden_at', { ascending: false });
  if (error) return []; // before schema_v4.sql: nothing hidden yet
  // one entry per place, however many saved copies it has
  const seen = new Set<string>();
  const rows = (data ?? []).filter((r) => {
    const key = r.google_place_id ?? `row:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return rows.map((r) => ({
    id: r.id,
    googleId: r.google_place_id ?? null,
    name: r.google_name ?? r.title ?? 'Unnamed place',
    reason: r.hidden_reason as HideReason,
    hidden_at: r.hidden_at,
  }));
}
