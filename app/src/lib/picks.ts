import { supabase, type NearbyPlace } from './supabase';

export type Mention = { source: string | null; title: string | null; link: string | null; published: string | null; says: string | null };
export type PickReceipt = { kind: 'saved' | 'not_interested'; googleId: string; placeId: number | null };

async function userId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('Not signed in');
  return data.user.id;
}

// Where a pick was mentioned: outlet, article, link (newest first)
export async function pickMentions(googleId: string): Promise<Mention[]> {
  const { data } = await supabase
    .from('candidates')
    .select('source, item_title, item_link, published, what_it_says, created_at, item_id, in_bay_area')
    .eq('google_place_id', googleId)
    .order('created_at', { ascending: false })
    .limit(8);
  const seen = new Set<string>();
  return (data ?? [])
    // a Bay Area article matched to a place outside the Bay Area is about some other place with the same name
    .filter((r) => String(r.item_id ?? '').startsWith('here:') || r.in_bay_area !== false)
    .slice(0, 5)
    .filter((r) => {
      // one line per article; Google searches (several queries can find the same place) count once
      const k = r.source === 'Google Maps search' || r.source === 'Known locally' ? r.source : (r.item_link ?? r.item_title ?? '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => ({ source: r.source, title: r.item_title, link: r.item_link, published: r.published, says: r.what_it_says }));
}

// "Want to go": add the pick to the user's Want to go list (in the app; the Google list doesn't change),
// with where it came from, and record "want" so it counts toward taste.
export async function saveFromPick(p: NearbyPlace): Promise<PickReceipt> {
  const uid = await userId();
  const gid = p.google_place_id ?? p.ref;
  const [m] = await pickMentions(gid);
  const { data, error } = await supabase
    .from('places')
    .upsert(
      {
        user_id: uid,
        place_key: `pick:${gid}`,
        list_name: 'want_to_go',
        added_via: 'pick',
        list_set_in_app: true,
        title: p.name,
        google_place_id: gid,
        google_name: p.name,
        address: p.address,
        location: `SRID=4326;POINT(${p.place_lng} ${p.place_lat})`,
        categories: p.categories,
        is_food: true,
        match_confidence: 'good',
        source_type: p.from_search || m?.source === 'Google Maps search' ? 'search' : 'publication',
        source_name: p.from_search ? null : (m?.source ?? null),
        source_url: m?.link ?? null,
        hidden_at: null,
        hidden_reason: null,
      },
      { onConflict: 'user_id,place_key' },
    )
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  await supabase
    .from('feedback')
    .upsert({ user_id: uid, google_place_id: gid, name: p.name, reaction: 'want' }, { onConflict: 'user_id,google_place_id' });
  return { kind: 'saved', googleId: gid, placeId: data?.id ?? null };
}

// "Not interested": the pick goes away for good and counts as a mild no (like "meh") for taste.
// The reason, if given, is what Discover uses to leave out places like it.
export async function notInterested(p: NearbyPlace, note?: string | null): Promise<PickReceipt> {
  const uid = await userId();
  const gid = p.google_place_id ?? p.ref;
  const { error } = await supabase
    .from('feedback')
    .upsert({ user_id: uid, google_place_id: gid, name: p.name, reaction: 'meh', note: note?.trim() || null }, { onConflict: 'user_id,google_place_id' });
  if (error) throw new Error(error.message);
  return { kind: 'not_interested', googleId: gid, placeId: null };
}

export async function undoPick(r: PickReceipt): Promise<void> {
  await supabase.from('feedback').delete().eq('google_place_id', r.googleId);
  if (r.placeId) await supabase.from('places').delete().eq('id', r.placeId);
}
