import { supabase, type NearbyPlace } from './supabase';

export type Reaction = 'love' | 'fine' | 'no';
export type BillItem = { name: string; qty: number; price: number | null };
export type Bill = { restaurant: string | null; date: string | null; items: BillItem[]; subtotal: number | null; tax: number | null; tip: number | null; total: number | null };
export type Visit = {
  id: number;
  visited_on: string;
  reaction: Reaction | null;
  thoughts: string | null;
  items: BillItem[];
  bill_total: number | null;
  photos: string[]; // signed URLs, good for an hour
  bill: string | null;
};

const BUCKET = 'visit-photos';
const NEEDS_V6 = 'Logging visits needs schema_v6.sql to be run in Supabase first.';

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Claude reads the bill photo (through the capture function); nothing is stored yet
export async function readBill(base64: string): Promise<{ bill: Bill; message?: string }> {
  const { data, error } = await supabase.functions.invoke('capture', { body: { type: 'bill', image_base64: base64 } });
  if (error) throw new Error('Could not read the bill. Is the updated capture function deployed?');
  return data as { bill: Bill; message?: string };
}

export type NewVisit = {
  place: NearbyPlace;
  date: string; // YYYY-MM-DD
  reaction: Reaction;
  thoughts: string;
  items: BillItem[];
  billTotal: number | null;
  billPhoto: string | null; // base64, uploaded only if kept
  foodPhotos: string[]; // base64
};

export async function saveVisit(v: NewVisit): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) throw new Error('Not signed in');
  const uid = u.user.id;
  const p = v.place;
  const gid = p.google_place_id ?? (p.kind === 'pick' ? p.ref : null);

  // a pick you went to stays in your places, as "Been there"
  let placeId: number | null = p.kind === 'saved' ? Number(p.ref) : null;
  if (p.kind === 'pick' && gid) {
    const { data, error } = await supabase
      .from('places')
      .upsert(
        {
          user_id: uid,
          place_key: `visit:${gid}`,
          list_name: 'visited',
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
        },
        { onConflict: 'user_id,place_key' },
      )
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    placeId = data?.id ?? null;
  }

  // photos go to the user's own folder in private storage
  const folder = `${uid}/${Date.now()}`;
  const paths: string[] = [];
  for (const [i, b64] of v.foodPhotos.entries()) {
    const path = `${folder}/food-${i + 1}.jpg`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes(b64), { contentType: 'image/jpeg' });
    if (error) throw new Error(/bucket/i.test(error.message) ? NEEDS_V6 : error.message);
    paths.push(path);
  }
  let billPath: string | null = null;
  if (v.billPhoto) {
    billPath = `${folder}/bill.jpg`;
    const { error } = await supabase.storage.from(BUCKET).upload(billPath, bytes(v.billPhoto), { contentType: 'image/jpeg' });
    if (error) throw new Error(/bucket/i.test(error.message) ? NEEDS_V6 : error.message);
  }

  const { error } = await supabase.from('visits').insert({
    user_id: uid,
    place_id: placeId,
    google_place_id: gid,
    place_name: p.name,
    visited_on: v.date,
    reaction: v.reaction,
    thoughts: v.thoughts.trim() || null,
    items_ordered: v.items.filter((i) => i.name.trim()),
    bill_total: v.billTotal,
    photo_paths: paths,
    bill_path: billPath,
  });
  if (error) throw new Error(/bill_path|place_name|bill_total/.test(error.message) ? NEEDS_V6 : error.message);

  // the latest visit is the place's reaction for taste and picks: loved it / fine / wouldn't go back
  if (gid) {
    await supabase.from('feedback').upsert(
      { user_id: uid, google_place_id: gid, name: p.name, reaction: v.reaction === 'love' ? 'love' : v.reaction === 'fine' ? 'want' : 'no' },
      { onConflict: 'user_id,google_place_id' },
    );
  }
}

export async function listVisits(p: NearbyPlace): Promise<Visit[]> {
  const gid = p.google_place_id ?? (p.kind === 'pick' ? p.ref : null);
  let q = supabase
    .from('visits')
    .select('id, visited_on, reaction, thoughts, items_ordered, bill_total, photo_paths, bill_path')
    .order('visited_on', { ascending: false })
    .limit(20);
  q = gid ? q.eq('google_place_id', gid) : q.eq('place_id', Number(p.ref));
  const { data, error } = await q;
  if (error || !data) return [];
  const all = data.flatMap((r) => [...(r.photo_paths ?? []), ...(r.bill_path ? [r.bill_path] : [])]);
  const signed: Record<string, string> = {};
  if (all.length) {
    const { data: urls } = await supabase.storage.from(BUCKET).createSignedUrls(all, 3600);
    for (const u of urls ?? []) if (u.path && u.signedUrl) signed[u.path] = u.signedUrl;
  }
  return data.map((r) => ({
    id: r.id,
    visited_on: r.visited_on,
    reaction: r.reaction,
    thoughts: r.thoughts,
    items: Array.isArray(r.items_ordered) ? r.items_ordered : [],
    bill_total: r.bill_total,
    photos: (r.photo_paths ?? []).map((x: string) => signed[x]).filter(Boolean),
    bill: r.bill_path ? (signed[r.bill_path] ?? null) : null,
  }));
}

export const REACTION_LABEL: Record<Reaction, string> = { love: 'Loved it', fine: 'Fine', no: "Wouldn't go back" };
