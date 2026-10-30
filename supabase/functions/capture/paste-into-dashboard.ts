// ONE-FILE VERSION for pasting into the Supabase dashboard editor (Edge Functions > capture > Code).
// Generated from index.ts + core.ts + discover.ts + onboard.ts + search.ts + starter.ts by build-paste.py; edit those, not this.

// Supabase Edge Function "capture": the server side of "Add a place".
// Reads a link, pasted text, a photo or a friend's tip with Claude, then suggests Google matches.
// Also reads a bill photo into a list of items (type "bill", for Log a visit), and runs
// Discover here (type "discover", modes "google" and "web"): see discover.ts.
// Keys stay here (secrets ANTHROPIC_API_KEY and GOOGLE_MAPS_API_KEY); the app never sees them.
// Nothing is saved here: the app saves the place the user picks.
//
// Request (signed-in users only): POST { type, url?, text?, friend?, image_base64?, lat?, lng? }
// Response: { source, places: [{ name, note, dishes, candidates: [...] }], message? }
import { createClient } from 'npm:@supabase/supabase-js@2';


const URL_ = Deno.env.get('SUPABASE_URL')!;
const firstKey = (json: string | undefined) => {
  try {
    const d = JSON.parse(json ?? '{}');
    return d.default ?? Object.values(d)[0];
  } catch {
    return undefined;
  }
};
const SECRET = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? firstKey(Deno.env.get('SUPABASE_SECRET_KEYS'));
const PUBLIC = Deno.env.get('SUPABASE_ANON_KEY') ?? firstKey(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'));
const GOOGLE_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY');
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = 'claude-sonnet-5-5'; // reads photos and long pages well
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function fetchPage(url: string) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en' }, redirect: 'follow' });
  const html = (await r.text()).slice(0, 2_000_000);
  return { finalUrl: r.url || url, status: r.status, html };
}

async function claude(content: unknown[], noSystem = false): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, ...(noSystem ? {} : { system: SYSTEM }), messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
}

// Discover here: Text Search inside the area's box; with rating fields when ranking by quality
async function googleInBox(query: string, box: Box, rating: boolean) {
  const fields = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.types', 'places.primaryType', 'places.businessStatus', 'places.googleMapsUri'];
  if (rating) fields.push('places.rating', 'places.userRatingCount', 'places.priceLevel');
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY!, 'X-Goog-FieldMask': fields.join(',') },
    body: JSON.stringify({ textQuery: query, pageSize: 20, locationRestriction: { rectangle: box } }),
  });
  if (!r.ok) return [];
  return (await r.json()).places ?? [];
}

// Claude with web search; a long search turn can pause, so send it back to continue
async function claudeWeb(prompt: string) {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  };
  let text = '';
  let searches = 0;
  const queries: string[] = [];
  const pages: { url: string; title: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    searches += d.usage?.server_tool_use?.web_search_requests ?? 0;
    // for the trace: what Claude searched for and which pages came back
    for (const b of d.content ?? []) {
      if (b.type === 'server_tool_use' && b.input?.query) queries.push(String(b.input.query));
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r?.url) pages.push({ url: String(r.url), title: String(r.title ?? '') });
      }
    }
    text = (d.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    if (d.stop_reason !== 'pause_turn') break;
    body.messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: d.content }];
  }
  return { text, searches, queries, pages };
}

// Search bar: Google Places Autocomplete, and the chosen place's details (same session token)
async function autocomplete(body: Record<string, unknown>) {
  const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY! },
    body: JSON.stringify(body),
  });
  return r.ok ? await r.json() : {};
}
async function placeDetails(id: string, session?: string) {
  const qs = session ? `?sessionToken=${encodeURIComponent(session)}` : '';
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}${qs}`, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_KEY!,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,types,businessStatus,rating,userRatingCount,priceLevel',
    },
  });
  return r.ok ? await r.json() : null;
}

async function googleSearch(query: string, bias?: { lat: number; lng: number }) {
  const body: Record<string, unknown> = { textQuery: query, pageSize: 5 };
  if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 30000 } };
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY!,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.businessStatus',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return [];
  return (await r.json()).places ?? [];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!GOOGLE_KEY || !ANTHROPIC_KEY || !SECRET || !PUBLIC) {
    return Response.json({ error: 'Function is missing ANTHROPIC_API_KEY, GOOGLE_MAPS_API_KEY or Supabase keys' }, { status: 500, headers: cors });
  }
  const asUser = createClient(URL_, PUBLIC, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: who } = await asUser.auth.getUser();
  if (!who?.user) return Response.json({ error: 'Not signed in' }, { status: 401, headers: cors });

  let input: Input;
  try {
    input = await req.json();
  } catch {
    return Response.json({ error: 'Send JSON' }, { status: 400, headers: cors });
  }
  const TYPES = ['link', 'text', 'photo', 'friend', 'bill', 'discover', 'me', 'taste_read', 'taste_save', 'screenshot_list', 'place_search', 'place_get', 'starter_places'];
  if (!TYPES.includes(input?.type)) {
    return Response.json({ error: `type must be one of ${TYPES.join(', ')}` }, { status: 400, headers: cors });
  }
  if ((input.image_base64?.length ?? 0) > 7_000_000) {
    return Response.json({ error: 'Photo too large' }, { status: 413, headers: cors });
  }

  // the user's own shorthand ("A" = Alex) helps Claude read their notes and friends' names
  const admin = createClient(URL_, SECRET, { auth: { persistSession: false } });
  const { data: sh } = await admin.from('user_shorthand').select('term, name, type').eq('user_id', who.user.id);

  // the user's app_users row: made on first use (sign-in creates only the auth account)
  const uid0 = who.user.id;
  async function ensureUser(): Promise<string> {
    const { data: u } = await admin.from('app_users').select('handle').eq('user_id', uid0).maybeSingle();
    if (u?.handle) return u.handle as string;
    const handle = await makeHandle(who.user!.email ?? 'user', async (h) => {
      const { data } = await admin.from('app_users').select('user_id').eq('handle', h).maybeSingle();
      return !!data;
    });
    const { error } = await admin.from('app_users').upsert({ user_id: uid0, handle, email: who.user!.email ?? null }, { onConflict: 'user_id' });
    if (error) throw new Error(`creating your account: ${error.message}`);
    return handle;
  }

  try {
    const t = (input as { type: string }).type;
    if (t === 'me') {
      // called at launch: makes sure the account row exists and says whether onboarding is done
      const handle = await ensureUser();
      const [{ count: places }, { data: prof }, { data: job }] = await Promise.all([
        admin.from('places').select('id', { count: 'exact', head: true }).eq('user_id', uid0),
        admin.from('user_profiles').select('profile').eq('user_id', uid0).maybeSingle(),
        admin.from('import_jobs').select('id, kind, status, message, counts, created_at, finished_at').eq('user_id', uid0).order('id', { ascending: false }).limit(1).maybeSingle(),
      ]);
      return Response.json({ handle, places: places ?? 0, has_profile: !!prof, last_job: job ?? null }, { headers: cors });
    }
    if (t === 'place_search') {
      return Response.json(await placeSearch(input as unknown as SearchInput, { autocomplete, details: placeDetails }), { headers: cors });
    }
    if (t === 'place_get') {
      return Response.json(await placeGet(input as unknown as GetInput, { autocomplete, details: placeDetails }), { headers: cors });
    }
    if (t === 'taste_read') {
      return Response.json(await tasteRead(input as unknown as TasteInput, { claude, googleSearch }), { headers: cors });
    }
    if (t === 'screenshot_list') {
      return Response.json(await screenshotList(input as unknown as ShotInput, { claude, googleSearch }), { headers: cors });
    }
    if (t === 'taste_save') {
      const s = input as unknown as TasteSaveInput;
      // one row per Google place: the same place picked twice would make the upsert fail
      const seenIds = new Set<string>();
      const places = (Array.isArray(s.places) ? s.places : [])
        .filter((p) => p?.candidate?.google_place_id && !seenIds.has(p.candidate.google_place_id) && !!seenIds.add(p.candidate.google_place_id))
        .slice(0, 30);
      const handle = await ensureUser();
      if (places.length) {
        const { error } = await admin.from('places').upsert(places.map((p) => placeRow(uid0, p)), { onConflict: 'user_id,place_key' });
        if (error) throw new Error(`saving your places: ${error.message}`);
      }
      const prefs = prefRows(uid0, s);
      if (prefs.length) {
        const { error } = await admin.from('user_prefs').upsert(prefs, { onConflict: 'user_id,kind,value', ignoreDuplicates: true });
        if (error) throw new Error(`saving your likes: ${error.message}`);
      }
      // "Not for me" on local places: a mild no, so Discover doesn't suggest them
      const noes = (Array.isArray(s.noes) ? s.noes : []).filter((x) => x?.google_place_id && !seenIds.has(x.google_place_id)).slice(0, 20);
      if (noes.length) {
        const { error } = await admin.from('feedback').upsert(
          noes.map((x) => ({ user_id: uid0, google_place_id: x.google_place_id, name: x.name, reaction: 'meh' })),
          { onConflict: 'user_id,google_place_id' },
        );
        if (error) throw new Error(`saving your answers: ${error.message}`);
      }
      // a starter profile so Discover works now; never replaces a real one from profile.py
      const { data: prof } = await admin.from('user_profiles').select('profile').eq('user_id', uid0).maybeSingle();
      const existing = (typeof prof?.profile === 'string' ? JSON.parse(prof.profile) : prof?.profile) as { starter?: boolean } | null;
      if (!existing || existing.starter) {
        const { error } = await admin.from('user_profiles').upsert({ user_id: uid0, profile: starterProfile(handle, { ...s, places }), updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
        if (error) throw new Error(`saving your profile: ${error.message}`);
      }
      // the Mac mini builds the full profile and this week's picks
      await admin.from('import_jobs').insert({ user_id: uid0, kind: 'refresh' });
      return Response.json({ saved: places.length, handle }, { headers: cors });
    }
    if (t === 'starter_places') {
      return Response.json(await starterPlaces(input as unknown as StarterInput, { googleSearch: googleInBox }), { headers: cors });
    }
    if ((input as unknown as DiscoverInput).type === 'discover') {
      const d = input as unknown as DiscoverInput;
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number') {
        return Response.json({ error: 'lat and lng are required' }, { status: 400, headers: cors });
      }
      const uid = who.user.id;
      let runId: number | undefined; // this run's discover_runs row, left out of the daily count
      // the profile with the user's own edits, and how common each cuisine is (loaded once per run)
      let tasteCache: Promise<{ cuisines: Record<string, { share: number }>; dishes: string[]; avoid: string[]; base: { cuisine: string; share: number; pool_size: number }[] }> | null = null;
      const myTaste = () =>
        (tasteCache ??= (async () => {
          const [{ data }, { data: prefs }, { data: base }] = await Promise.all([
            admin.from('user_profiles').select('profile').eq('user_id', uid).maybeSingle(),
            admin.from('user_prefs').select('kind, value').eq('user_id', uid),
            admin.from('cuisine_base').select('cuisine, share, pool_size'),
          ]);
          const prof = typeof data?.profile === 'string' ? JSON.parse(data.profile) : data?.profile;
          return { ...editedTaste(prof, (prefs ?? []) as Pref[]), base: (base ?? []) as { cuisine: string; share: number; pool_size: number }[] };
        })());
      const ddeps: DiscoverDeps = {
        // most telling first: measured against how common each cuisine is in the shared Bay Area pool
        topCuisines: async () => {
          const t = await myTaste();
          return rankCuisines(t.cuisines, t.base, t.base[0]?.pool_size ?? 0).map((r) => r.cuisine);
        },
        knownIds: async () => {
          const [p, f] = await Promise.all([
            admin.from('places').select('google_place_id').eq('user_id', uid).not('google_place_id', 'is', null),
            admin.from('feedback').select('google_place_id').eq('user_id', uid),
          ]);
          return new Set([...(p.data ?? []), ...(f.data ?? [])].map((r) => r.google_place_id as string));
        },
        cachedQueries: async (key, days) => {
          const since = new Date(Date.now() - days * 86_400_000).toISOString();
          const { data } = await admin.from('feed_items').select('item_id').like('item_id', `here:${key}:%`).gte('fetched_at', since);
          return new Set((data ?? []).map((r) => r.item_id as string));
        },
        webRunsToday: async () => {
          const since = new Date(Date.now() - 86_400_000).toISOString();
          const { count } = await admin.from('discover_runs').select('id', { count: 'exact', head: true }).eq('user_id', uid).in('kind', ['web', 'web-started']).neq('id', runId ?? -1).gte('created_at', since);
          return count ?? 0;
        },
        webLimit: async () => {
          const { data } = await admin.from('app_users').select('discover_web_per_day').eq('user_id', uid).maybeSingle();
          return (data?.discover_web_per_day as number | null | undefined) ?? null;
        },
        googleSearch: googleInBox,
        claudeWeb,
        home: async () => {
          const { data } = await admin.rpc('home_point', { uid });
          const r = Array.isArray(data) ? data[0] : data;
          return r && typeof r.lat === 'number' && typeof r.lng === 'number' ? { lat: r.lat, lng: r.lng } : null;
        },
        getAreaProfile: async (ck) => {
          const { data } = await admin.from('area_profiles').select('profile').eq('city_key', ck).maybeSingle();
          return (data?.profile as AreaProfile | undefined) ?? null;
        },
        saveAreaProfile: async (ck, name, p) => {
          await admin.from('area_profiles').upsert({ city_key: ck, area_name: name, profile: p }, { onConflict: 'city_key' });
        },
        claudeText: (prompt) => claude([{ type: 'text', text: prompt }], true),
        // a few lines on the user's taste for the rerank: most telling cuisines, dishes, places they love,
        // suggestions they saved
        taste: async () => {
          const [t, fav, picked] = await Promise.all([
            myTaste(),
            admin.from('places').select('title, google_name').eq('user_id', uid).eq('list_name', 'favorites').eq('is_food', true).is('removed_at', null).order('created_at', { ascending: false }).limit(25),
            admin.from('places').select('title, google_name').eq('user_id', uid).eq('added_via', 'pick').order('created_at', { ascending: false }).limit(10),
          ]);
          const cuisines = rankCuisines(t.cuisines, t.base, t.base[0]?.pool_size ?? 0).slice(0, 8).map((r) => r.cuisine.replace(/_/g, ' '));
          const dishes = t.dishes.slice(0, 10);
          const names = (r: { data: { title: string | null; google_name: string | null }[] | null }) =>
            (r.data ?? []).map((p) => p.google_name ?? p.title).filter(Boolean).join(', ');
          return [
            cuisines.length ? `Cuisines they save more than most people: ${cuisines.join(', ')}` : '',
            dishes.length ? `Dishes they mention: ${dishes.join(', ')}` : '',
            names(fav) ? `Some favorites: ${names(fav)}` : '',
            names(picked) ? `Suggestions they saved: ${names(picked)}` : '',
            t.avoid.length ? `They avoid: ${t.avoid.join(', ')}` : '',
          ].filter(Boolean).join('\n');
        },
        // the reasons they gave for "Not interested" and "didn't like it", newest first, plus dislikes from onboarding
        dislikes: async () => {
          const [f, p] = await Promise.all([
            admin.from('feedback').select('name, note').eq('user_id', uid).in('reaction', ['meh', 'no']).not('note', 'is', null).order('created_at', { ascending: false }).limit(25),
            admin.from('user_prefs').select('value').eq('user_id', uid).eq('kind', 'dislike_other').limit(10),
          ]);
          return [
            ...(f.data ?? []).map((r) => (r.name ? `${r.name}: ${r.note}` : String(r.note))),
            ...(p.data ?? []).map((r) => `In general: ${r.value}`),
          ];
        },
        existingForArea: async (_key, prefix) => {
          const { data } = await admin.from('candidates').select('google_place_id, name, cuisine, source').like('item_id', `${prefix}%`).not('google_place_id', 'is', null);
          return (data ?? []) as { google_place_id: string; name: string | null; cuisine: string | null; source: string }[];
        },
        save: async (items, rows, scores, key, mode) => {
          // one row per key: a search can return two branches with the same name (the table's key is item_id + name)
          const once = <T,>(xs: T[], k: (x: T) => string) => [...new Map(xs.map((x) => [k(x), x] as const)).values()].reverse();
          items = once([...items].reverse(), (x) => x.item_id);
          rows = once([...rows].reverse(), (r) => `${r.item_id}|${r.name}`);
          scores = once([...scores].reverse(), (x) => x.google_place_id);
          if (items.length) {
            const now = new Date().toISOString();
            await admin.from('feed_items').upsert(items.map((x) => ({ item_id: x.item_id, source: x.source, title: x.title, link: x.link, fetched_at: now, status: 'done' })), { onConflict: 'item_id' });
          }
          if (rows.length) {
            const { error } = await admin.from('candidates').upsert(rows, { onConflict: 'item_id,name' });
            if (error) {
              // un-mark the searches so the next tap searches again instead of reusing an empty result
              if (items.length) await admin.from('feed_items').delete().in('item_id', items.map((x) => x.item_id));
              throw new Error(`saving places: ${error.message}`);
            }
          }
          if (scores.length) {
            await admin.from('pick_scores').upsert(scores.map((x) => ({ user_id: uid, google_place_id: x.google_place_id, score: x.score, reason: x.reason, source: 'discover', updated_at: new Date().toISOString() })), { onConflict: 'user_id,google_place_id' });
          }
        },
      };
      // every run is saved with its trace, success or not. The row is written first as '<mode>-started', so a run
      // cut off by a time limit still shows up (a 'web-started' row also counts toward the daily web limit).
      const trace: Trace = { area_name: d.area_name ?? null, lat: d.lat, lng: d.lng, radius_m: d.radius_m ?? null };
      const t0 = Date.now();
      let error: string | null = null;
      const { data: run } = await admin.from('discover_runs')
        .insert({ user_id: uid, area_key: areaKey(d.lat, d.lng), area_name: d.area_name ?? null, kind: `${d.mode}-started`, trace })
        .select('id').single();
      runId = run?.id as number | undefined;
      try {
        const out = d.mode === 'web' ? await discoverWeb(d, ddeps, trace) : await discoverGoogle(d, ddeps, trace);
        return Response.json(out, { headers: cors });
      } catch (e) {
        error = (e as Error).message;
        throw e;
      } finally {
        const done = { kind: (trace.kind as string) ?? `${d.mode}-error`, ms: Date.now() - t0, error, trace };
        if (run?.id) await admin.from('discover_runs').update(done).eq('id', run.id);
        else await admin.from('discover_runs').insert({ user_id: uid, area_key: areaKey(d.lat, d.lng), area_name: d.area_name ?? null, ...done });
      }
    }
    const deps = { fetchPage, claude, googleSearch, shorthand: sh ?? [] };
    const result = input.type === 'bill' ? await readBill(input, deps) : await capture(input, deps);
    return Response.json(result, { headers: cors });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502, headers: cors });
  }
});

// ---------- core.ts ----------

// "Add a place": find the place(s) in a link, pasted text, a photo or a friend's tip, and suggest
// Google matches for each. Pure logic with injected network calls so it can be tested; index.ts wires it up.

export type Input = {
  type: 'link' | 'text' | 'photo' | 'friend' | 'bill' | 'discover';
  url?: string;
  text?: string;
  friend?: string; // for type "friend": who recommended it
  image_base64?: string; // for type "photo": JPEG, already resized on the phone
  lat?: number; // where the user is (or where the photo was taken)
  lng?: number;
};

export type Candidate = {
  google_place_id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  categories: string[];
  is_food: boolean;
  open: boolean;
};

export type Found = {
  name: string;
  location_hint: string;
  note: string; // what the source said about it, in plain words
  dishes: string[];
  candidates: Candidate[];
};

export type Source = { type: string; name: string | null; url: string | null };
export type Result = { source: Source; places: Found[]; message?: string };

// ---------- reading a bill (Log a visit) ----------

export type BillItem = { name: string; qty: number; price: number | null };
export type Bill = { restaurant: string | null; date: string | null; items: BillItem[]; subtotal: number | null; tax: number | null; tip: number | null; total: number | null };

export const BILL_PROMPT = `This is a photo of a restaurant bill or receipt. List what was ordered.
Answer with JSON only:
{"restaurant": "name on the bill or null", "date": "YYYY-MM-DD or null",
 "items": [{"name": "item as written, cleaned up", "qty": 1, "price": 12.5}],
 "subtotal": number or null, "tax": number or null, "tip": number or null, "total": number or null}
Prices are the line totals in the bill's currency, numbers only. Leave out discounts, fees and payment lines.
Never include card numbers, card types, authorization codes, names of the card holder or server, or any payment details.`;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

export function parseBill(text: string): Bill {
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const d = JSON.parse(raw);
    const items = (Array.isArray(d.items) ? d.items : [])
      .filter((i: { name?: unknown }) => typeof i?.name === 'string' && i.name.trim())
      // nothing that looks like a card number survives, even if it slipped into an item name
      .filter((i: { name: string }) => !/\d{4}[ -]?\d{4}|x{4}|\*{4}|visa|mastercard|amex|auth/i.test(i.name))
      .slice(0, 40)
      .map((i: { name: string; qty?: unknown; price?: unknown }) => ({
        name: i.name.trim(),
        qty: typeof i.qty === 'number' && i.qty > 0 ? i.qty : 1,
        price: num(i.price),
      }));
    const date = typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null;
    return {
      restaurant: typeof d.restaurant === 'string' ? d.restaurant : null,
      date, items, subtotal: num(d.subtotal), tax: num(d.tax), tip: num(d.tip), total: num(d.total),
    };
  } catch {
    return { restaurant: null, date: null, items: [], subtotal: null, tax: null, tip: null, total: null };
  }
}

export type Deps = {
  fetchPage: (url: string) => Promise<{ finalUrl: string; status: number; html: string }>;
  claude: (content: unknown[], noSystem?: boolean) => Promise<string>; // returns Claude's text answer
  googleSearch: (query: string, bias?: { lat: number; lng: number }) => Promise<Record<string, unknown>[]>;
  shorthand?: { term: string; name: string; type: string }[]; // the user's own names ("A" = Alex)
};

const MAX_PLACES = 30; // a "best of" article or a notes list can name many; the user reviews each
const FOOD = /restaurant|food|cafe|coffee|bakery|bar|pub|brewery|winery|meal_|ice_cream|dessert|tea|juice|deli|market|confectionery|donut|bagel/;

// ---------- reading a link ----------

export function isTikTok(u: string): boolean {
  try {
    return /(^|\.)tiktok\.com$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
}
export function isInstagram(u: string): boolean {
  try {
    return /(^|\.)instagram\.com$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
}
// TikTok's embed info (oEmbed): the video's caption ("title") and creator
export function parseTikTok(json: string): { caption: string; author: string } | null {
  try {
    const d = JSON.parse(json);
    const caption = typeof d.title === 'string' ? d.title.trim() : '';
    if (!caption) return null;
    return { caption: caption.slice(0, 3000), author: typeof d.author_name === 'string' ? d.author_name : '' };
  } catch {
    return null;
  }
}

export function isMapsUrl(u: string): boolean {
  return /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(u);
}

// "https://www.google.com/maps/place/Taste+of+Urumqi/@37.79,-122.41,17z/..." -> name and point
export function parseMapsUrl(u: string): { name: string | null; lat: number | null; lng: number | null } {
  let name: string | null = null;
  const m = u.match(/\/maps\/place\/([^/@?]+)/);
  if (m) name = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() || null;
  if (!name) {
    const q = u.match(/[?&]q=([^&]+)/);
    if (q) name = decodeURIComponent(q[1].replace(/\+/g, ' ')).trim() || null;
  }
  const at = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ?? u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  return { name, lat: at ? Number(at[1]) : null, lng: at ? Number(at[2]) : null };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Title, description, site name and readable text from a page
export function pageText(html: string, limit = 15000): { title: string; site: string; text: string } {
  const meta = (prop: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
    return decodeEntities((html.match(re)?.[1] ?? html.match(re2)?.[1] ?? '').trim());
  };
  const title = meta('og:title') || decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '');
  const site = meta('og:site_name');
  const desc = meta('og:description') || meta('description');
  const body = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|header|footer|nav)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
  return { title, site, text: [title, desc, body].filter(Boolean).join('\n\n').slice(0, limit) };
}

// ---------- asking Claude ----------

export const SYSTEM = `You help someone save food and drink places they want to try. From what they give you
(a web page, pasted text, a friend's tip, or a photo), list each specific restaurant, cafe, bakery, bar,
food truck or food shop it names or shows. Skip places only mentioned in passing (as a comparison, or
"formerly X"). For a storefront photo, read the business name from the sign. For a screenshot, read the text.

Answer with JSON only, no other text:
{"source": {"type": "person" | "publication" | "community" | "creator" | "walk_by" | "other", "name": "..." or null},
 "places": [{"name": "...", "location_hint": "neighborhood, street or city if given, else empty",
             "note": "one short sentence in your own words: what it is and what was said about it",
             "dishes": ["dishes or drinks named for this place"]}]}
List every place, up to 30. If there are none, return an empty list.`;

export function parseClaude(text: string): { source: { type: string; name: string | null }; places: Omit<Found, 'candidates'>[] } {
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const d = JSON.parse(raw);
    const places = (Array.isArray(d.places) ? d.places : [])
      .filter((p: { name?: unknown }) => typeof p?.name === 'string' && p.name.trim())
      .slice(0, MAX_PLACES)
      .map((p: { name: string; location_hint?: string; note?: string; dishes?: unknown }) => ({
        name: p.name.trim(),
        location_hint: (p.location_hint ?? '').trim(),
        note: (p.note ?? '').trim(),
        dishes: Array.isArray(p.dishes) ? p.dishes.filter((x): x is string => typeof x === 'string').slice(0, 8) : [],
      }));
    return { source: { type: d.source?.type ?? 'other', name: d.source?.name ?? null }, places };
  } catch {
    return { source: { type: 'other', name: null }, places: [] };
  }
}

// ---------- matching on Google ----------

export function toCandidate(g: Record<string, unknown>): Candidate | null {
  const id = g.id as string | undefined;
  if (!id) return null;
  const loc = (g.location ?? {}) as { latitude?: number; longitude?: number };
  const types = (g.types as string[] | undefined) ?? [];
  return {
    google_place_id: id,
    name: ((g.displayName as { text?: string } | undefined)?.text ?? '').trim(),
    address: (g.formattedAddress as string | undefined) ?? null,
    lat: loc.latitude ?? null,
    lng: loc.longitude ?? null,
    categories: types,
    is_food: types.some((t) => FOOD.test(t)),
    open: ((g.businessStatus as string | undefined) ?? 'OPERATIONAL') === 'OPERATIONAL',
  };
}

async function matchOnGoogle(name: string, hint: string, bias: { lat: number; lng: number } | undefined, deps: Deps) {
  const results = await deps.googleSearch([name, hint].filter(Boolean).join(' '), bias);
  return results
    .map(toCandidate)
    .filter((c): c is Candidate => !!c)
    .sort((a, b) => Number(b.is_food) - Number(a.is_food) || Number(b.open) - Number(a.open)) // food and open first
    .slice(0, 3);
}

// ---------- the whole thing ----------

export async function readBill(input: Input, deps: Deps): Promise<{ bill: Bill; message?: string }> {
  if (!input.image_base64) return { bill: parseBill(''), message: 'No photo received.' };
  const text = await deps.claude([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image_base64 } },
    { type: 'text', text: BILL_PROMPT },
  ], true);
  const bill = parseBill(text);
  return { bill, message: bill.items.length ? undefined : "Couldn't read items from that photo. Try a sharper, flatter shot." };
}

export async function capture(input: Input, deps: Deps): Promise<Result> {
  const bias = typeof input.lat === 'number' && typeof input.lng === 'number' ? { lat: input.lat, lng: input.lng } : undefined;
  const shorthand = (deps.shorthand ?? []).map((s) => `"${s.term}" means ${s.name} (${s.type})`).join('; ');
  const known = shorthand ? `\nThe user's own shorthand: ${shorthand}.` : '';

  if (input.type === 'link') {
    const url = (input.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return { source: { type: 'other', name: null, url: null }, places: [], message: 'That doesn\'t look like a link.' };
    // TikTok and Instagram pages don't let apps read them. TikTok publishes each video's caption and creator
    // for embedding, which usually names the place; Instagram needs a business-verified Facebook app for that.
    if (isTikTok(url)) {
      // short share links (vm.tiktok.com/...) redirect to the video page; the embed info needs that full link
      const full = /^(vm|vt)\./i.test(new URL(url).hostname) ? ((await deps.fetchPage(url).catch(() => null))?.finalUrl ?? url) : url;
      const embed = await deps.fetchPage(`https://www.tiktok.com/oembed?url=${encodeURIComponent(full)}`).catch(() => null);
      const info = parseTikTok(embed?.html ?? '');
      if (!info) return { source: { type: 'creator', name: null, url }, places: [], message: "Couldn't read that TikTok. Share a screenshot of the video instead (Photo)." };
      const answer = await deps.claude([
        { type: 'text', text: `A TikTok video the user wants to save places from.${known}\nCreator: ${info.author}\nCaption: ${info.caption}` },
      ]);
      const parsed = parseClaude(answer);
      const places = await Promise.all(parsed.places.map(async (p) => ({ ...p, candidates: await matchOnGoogle(p.name, p.location_hint, bias, deps) })));
      return {
        source: { type: 'creator', name: info.author ? `${info.author} on TikTok` : 'TikTok', url },
        places,
        message: places.length ? undefined : "The caption doesn't name a place. Share a screenshot of the video where the name shows (Photo).",
      };
    }
    if (isInstagram(url)) {
      return { source: { type: 'creator', name: 'Instagram', url }, places: [], message: "Instagram doesn't let apps read posts. Share a screenshot of the post instead (Photo)." };
    }

    const page = await deps.fetchPage(url).catch(() => null);
    const finalUrl = page?.finalUrl ?? url;

    // a Google Maps link names one place: no need for Claude
    if (isMapsUrl(finalUrl) || isMapsUrl(url)) {
      const m = parseMapsUrl(finalUrl);
      const name = m.name ?? (page ? pageText(page.html).title.replace(/ - Google Maps$/, '') : '');
      if (!name) return { source: { type: 'other', name: 'Google Maps', url }, places: [], message: 'Could not read that Maps link. Try pasting the place name.' };
      const near = m.lat !== null && m.lng !== null ? { lat: m.lat, lng: m.lng } : bias;
      return {
        source: { type: 'other', name: 'Google Maps', url },
        places: [{ name, location_hint: '', note: '', dishes: [], candidates: await matchOnGoogle(name, '', near, deps) }],
      };
    }

    const readable = page && page.status < 400 ? pageText(page.html) : null;
    if (!readable || readable.text.length < 200) {
      return {
        source: { type: 'other', name: null, url },
        places: [],
        message: 'That site doesn\'t let apps read it (Instagram often does this). Paste the caption or text, or add a screenshot as a photo.',
      };
    }
    const answer = await deps.claude([
      { type: 'text', text: `A web page the user wants to save places from.${known}\nURL: ${url}\nSite: ${readable.site}\n\n${readable.text}` },
    ]);
    const parsed = parseClaude(answer);
    const places = await Promise.all(parsed.places.map(async (p) => ({ ...p, candidates: await matchOnGoogle(p.name, p.location_hint, bias, deps) })));
    return {
      source: { type: parsed.source.type === 'other' ? 'publication' : parsed.source.type, name: readable.site || parsed.source.name || new URL(url).hostname.replace(/^www\./, ''), url },
      places,
      message: places.length ? undefined : 'No places found on that page.',
    };
  }

  let content: unknown[];
  if (input.type === 'photo') {
    if (!input.image_base64) return { source: { type: 'walk_by', name: null, url: null }, places: [], message: 'No photo received.' };
    content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image_base64 } },
      { type: 'text', text: `A photo the user took or a screenshot they saved: a storefront, menu, or a post about a place.${known}${input.text ? `\nThey added: ${input.text}` : ''}` },
    ];
  } else {
    const text = (input.text ?? '').trim();
    if (!text) return { source: { type: 'other', name: null, url: null }, places: [], message: 'Nothing to read yet.' };
    const who = input.type === 'friend' && input.friend ? `A recommendation from ${input.friend.trim()}.` : 'Text the user pasted (a post, comment, message or note).';
    content = [{ type: 'text', text: `${who}${known}\n\n${text.slice(0, 15000)}` }];
  }

  const parsed = parseClaude(await deps.claude(content));
  const places = await Promise.all(parsed.places.map(async (p) => ({ ...p, candidates: await matchOnGoogle(p.name, p.location_hint, bias, deps) })));
  const source: Source =
    input.type === 'friend'
      ? { type: 'person', name: input.friend?.trim() || parsed.source.name, url: null }
      : input.type === 'photo'
        ? { type: parsed.source.type === 'other' ? 'walk_by' : parsed.source.type, name: parsed.source.name, url: null }
        : { type: parsed.source.type, name: parsed.source.name, url: null };
  return { source, places, message: places.length ? undefined : 'No places found. Try adding the name or a bit more text.' };
}

// ---------- discover.ts ----------

// "Discover here": find places in the area on screen that fit this user's taste.
// Two modes, called separately by the app so quick results show while the slow ones run:
//   google  seconds: Google search for the user's top cuisines in the area, well-rated or new places
//   web     a minute: Claude searches the web (local food press, "best new" lists) for the area
// Results go into the shared pool of picks (candidates), so they show in Nearby, and each one gets a
// score and reason for this user (pick_scores). Areas are cached for 30 days, shared by all users.
// Away from home (over AWAY_KM from where most of the user's saves are), it favors what the place is
// known for: local specialties first, the user's cuisines when they are also a local strength, things the
// city does especially well (pizza and coffee in Tokyo), and other cuisines only when the place is a standout.
// What each city is known for is asked once and shared by all users (area_profiles).
// Each run fills a trace (what was searched, what came back, what was dropped and why); index.ts saves it
// in discover_runs.
// Pure logic with injected calls so it can be tested; index.ts wires it up.

export type DiscoverInput = { type: 'discover'; mode: 'google' | 'web'; lat: number; lng: number; radius_m?: number; area_name?: string };

export type DPlace = Record<string, unknown>;
export type CandidateRow = {
  item_id: string;
  source: string;
  item_title: string;
  item_link: string | null;
  name: string;
  location_hint: string;
  mention_type: string;
  cuisine: string | null;
  dishes: string[];
  what_it_says: string;
  google_place_id: string;
  google_name: string;
  address: string | null;
  location: string | null; // EWKT point
  categories: string[];
  primary_type: string | null;
  business_status: string;
  maps_uri: string | null;
  match_confidence: string;
  is_food: boolean;
  in_bay_area: boolean;
  tone: string;
};
export type Score = { google_place_id: string; score: number; reason: string };
// filled in as a run goes; saved by index.ts whether the run succeeds or fails
export type Trace = Record<string, unknown>;
export type WebResult = { text: string; searches: number; queries?: string[]; pages?: { url: string; title: string }[] };
export type Specialty = { name: string; query: string; tags: string[] };
export type Institution = { name: string; why: string };
// size: major | mid | small; institutions: the places the city is known for (asked since Oct 30; older profiles are asked again once)
export type AreaProfile = { size?: string; local: Specialty[]; strengths: Specialty[]; institutions?: Institution[]; area?: string };

export type DiscoverDeps = {
  topCuisines: () => Promise<string[]>; // this user's, strongest first
  knownIds: () => Promise<Set<string>>; // saved or reacted to: never suggested
  cachedQueries: (areaKey: string, days: number) => Promise<Set<string>>; // item_ids searched recently
  webRunsToday: () => Promise<number>;
  webLimit?: () => Promise<number | null>; // this user's own daily web limit, if set (else WEB_PER_DAY)
  googleSearch: (query: string, box: Box, rating: boolean) => Promise<DPlace[]>;
  claudeWeb: (prompt: string) => Promise<WebResult>;
  save: (items: { item_id: string; source: string; title: string; link: string | null }[], rows: CandidateRow[], scores: Score[], areaKey: string, mode: string) => Promise<void>;
  existingForArea: (areaKey: string, prefix: string) => Promise<{ google_place_id: string; name?: string | null; cuisine: string | null; source: string }[]>;
  home: () => Promise<{ lat: number; lng: number } | null>; // center of most of the user's saves
  getAreaProfile: (cityKey: string) => Promise<AreaProfile | null>;
  saveAreaProfile: (cityKey: string, areaName: string, p: AreaProfile) => Promise<void>;
  claudeText: (prompt: string) => Promise<string>; // no web search: fast
  dislikes?: () => Promise<string[]>; // what this user said no to, in their words ("Golden Dragon: looks American Chinese")
  taste?: () => Promise<string>; // a few lines on the user's taste for the rerank (cuisines, dishes, places they love)
};

export type Box = { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };

export const CACHE_DAYS = 30;
export const WEB_PER_DAY = 3;
export const AWAY_KM = 100;
const TOO_BROAD = new Set(['american', 'asian', 'european', 'fusion', 'cafe', 'restaurant', 'breakfast', 'brunch']);
// global chains: never a discovery, home or away
const CHAINS = /^(round table|mountain mike'?s|peet'?s|in-n-out|jack in the box|carl'?s jr|del taco|el pollo loco|panera|olive garden|applebee'?s|chili'?s|denny'?s|ihop|red robin|the cheesecake factory|cheesecake factory|p\.? ?f\.? chang'?s|buffalo wild wings|wingstop|jersey mike'?s|jimmy john'?s|firehouse subs|noodles & company|pieology|mod pizza|blaze pizza|the habit burger|togo'?s|jamba|black bear diner|marie callender'?s|raising cane'?s|whataburger|sonic drive-in|arby'?s|qdoba|texas roadhouse|red lobster|cracker barrel|cold stone|yogurtland|pinkberry|auntie anne'?s|cinnabon|jollibee|dutch bros|the coffee bean|coffee bean & tea leaf|tropical smoothie|smoothie king|sweetgreen|cava|pizza hut|kfc|mcdonald'?s|starbucks|domino'?s|subway|burger king|papa john'?s|dunkin'?|taco bell|wendy'?s|tim hortons|costa coffee|dairy queen|hard rock cafe|five guys|shake shack|popeyes|chick-fil-a|little caesars|panda express|chipotle|sizzler|tgi friday'?s|outback steakhouse|haagen-dazs|baskin-robbins|krispy kreme|7-eleven|family ?mart|lawson|luckin coffee|mixue|yoshinoya|sukiya|matsuya|coco ichibanya|saizeriya)\b/i;
export function isChain(name: string): boolean {
  return CHAINS.test(name.trim().replace(/[’`]/g, "'"));
}
const FOOD_D = /restaurant|food|cafe|coffee|bakery|bar|pub|brewery|winery|meal_|ice_cream|dessert|tea|juice|deli|confectionery|donut|bagel/;

// ---------- what the user said no to ----------

// ---------- the rerank: one Claude call reads the user's taste and every place Discover found ----------
// It scores each place for this person with a specific reason, flags chains (regional ones the name list
// misses, like Round Table) and, when the user has said why they turned places down, places like those.
// If the call fails, Discover keeps its own ranking.

export type RerankItem = { id: string; name: string; detail: string; score: number; reason: string };

export function rerankPrompt(taste: string, dislikes: string[], places: RerankItem[]): string {
  const noes = dislikes.length ? `\nWhen they turned suggestions down, they said:\n${dislikes.map((d) => `- ${d}`).join('\n')}\n` : '';
  return `An app suggests restaurants, cafes and bars to one person. What it knows about their taste:
${taste || '(not much yet)'}
${noes}
Places found near where they are looking (name, then what Google or an article says about it):
${places.map((p, i) => `${i + 1}. ${p.name}${p.detail ? ` (${p.detail})` : ''}`).join('\n')}

For every place:
- "fit": 0-100, how likely this person is to want to try it, from their taste (not just popularity).
- "why": one short reason for this person, specific where you can ("Hand-pulled noodles, like Xi'an Famous you
  saved"). Plain words, under 12 words, no flattery. Don't claim they've been anywhere.
- "chain": true for a business with many locations under the same name across a region or the country
  (Round Table Pizza, Peet's Coffee, Panera). A local business with a few locations in one city is not a chain.${dislikes.length ? `
- "no": true only when the name or details make it clear they'd turn it down for the reasons they gave
  (a reason like "too far" or "too pricey" for one place says little about others).` : ''}
Answer with only a JSON array, one object per place: [{"n": 1, "fit": 72, "why": "...", "chain": false${dislikes.length ? ', "no": false' : ''}}]`;
}

export async function rerank(items: RerankItem[], deps: DiscoverDeps, trace: Trace): Promise<Score[]> {
  const keep = (xs: RerankItem[]) => xs.map((x) => ({ google_place_id: x.id, score: x.score, reason: x.reason }));
  if (!items.length) return [];
  const list = items.slice(0, 60);
  const [taste, dislikes] = await Promise.all([
    deps.taste?.().catch(() => '') ?? Promise.resolve(''),
    deps.dislikes?.().catch(() => [] as string[]) ?? Promise.resolve([] as string[]),
  ]);
  const answer = await deps.claudeText(rerankPrompt(taste, dislikes, list)).catch(() => '');
  let parsed: { n?: unknown; fit?: unknown; why?: unknown; chain?: unknown; no?: unknown }[];
  try {
    const m = answer.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(m ? m[0] : 'null');
    if (!Array.isArray(parsed)) throw new Error('no list');
  } catch {
    trace.rerank = 'could not read the answer; kept Discover\'s own ranking';
    return keep(items);
  }
  const byN = new Map(parsed.map((x) => [Number(x?.n), x]));
  const chains: string[] = [];
  const noes: { name: string; why: string }[] = [];
  const tr: { name: string; fit: number | null; why: string; score: number }[] = [];
  const out: Score[] = [];
  list.forEach((p, i) => {
    const x = byN.get(i + 1);
    if (x?.chain === true) return void chains.push(p.name);
    if (dislikes.length && x?.no === true) return void noes.push({ name: p.name, why: String(x?.why ?? '') });
    const fit = typeof x?.fit === 'number' ? Math.max(0, Math.min(100, x.fit)) : null;
    const why = String(x?.why ?? '').trim().slice(0, 140);
    // Discover's own score still counts (local specialties, quality); the fit for this person counts more.
    // A city's institutions keep their label ("A Boston institution: ...").
    const score = fit === null ? p.score : Math.round((0.3 * p.score + 0.7 * (fit / 100)) * 1000) / 1000;
    const reason = /institution/i.test(p.reason) || !why ? p.reason : why;
    out.push({ google_place_id: p.id, score, reason });
    tr.push({ name: p.name, fit, why, score });
  });
  out.push(...keep(items.slice(60)));
  trace.chains_left_out = chains;
  if (dislikes.length) trace.your_noes = { said: dislikes, left_out: noes };
  trace.rerank = tr.sort((a, b) => b.score - a.score);
  return out;
}

// ---------- which of the user's cuisines say the most about them ----------

// fallback base rates (as in match.py), used until the shared pool is big enough to measure them
export const BASE_CUISINE: Record<string, number> = {
  american: 0.15, chinese: 0.10, mexican: 0.10, italian: 0.07, japanese: 0.07, pizza: 0.06, burgers: 0.04,
  thai: 0.04, indian: 0.04, vietnamese: 0.04, korean: 0.03, mediterranean: 0.03, seafood: 0.03, french: 0.02,
  bbq: 0.02, middle_eastern: 0.02, californian: 0.03, 'uyghur/central_asian': 0.002,
};
export const MIN_POOL = 300; // places in the pool before its base rates are trusted

// as match.py's lift_score: half how much more often than a typical diner (full at 8x), half plain volume
export function liftScore(share: number, base: number, maxShare: number, cap = 8): number {
  if (share <= 0) return 0;
  const lift = share / base;
  const distinct = lift > 1 ? Math.max(0, Math.min(1, Math.log(lift) / Math.log(cap))) : 0;
  return 0.5 * distinct + 0.5 * Math.min(1, share / maxShare);
}

// the profile as the user has edited it ("Your taste" in the app): cuisines and dishes they hid come out,
// ones they added count now (the weekly rebuild on the mini folds them in properly)
export type Pref = { kind: string; value: string };
const normC = (c: string) => c.trim().toLowerCase().replace(/-/g, ' ').replace(/ /g, '_');
export function editedTaste(prof: { cuisines?: Record<string, { share?: number }>; dishes?: Record<string, number> } | null, prefs: Pref[]) {
  const hideC = new Set(prefs.filter((p) => p.kind === 'not_cuisine').map((p) => normC(p.value)));
  const hideD = new Set(prefs.filter((p) => p.kind === 'not_dish').map((p) => p.value.trim().toLowerCase()));
  const cuisines: Record<string, { share: number }> = {};
  for (const [c, v] of Object.entries(prof?.cuisines ?? {})) if (!hideC.has(c)) cuisines[c] = { share: v?.share ?? 0 };
  const top = Math.max(0.05, ...Object.values(cuisines).map((v) => v.share));
  for (const p of prefs) {
    const c = normC(p.value);
    if (p.kind === 'cuisine' && c && !hideC.has(c) && !(c in cuisines)) cuisines[c] = { share: top / 2 };
  }
  const dishes = [...new Set([...Object.keys(prof?.dishes ?? {}), ...prefs.filter((p) => p.kind === 'dish').map((p) => p.value.trim().toLowerCase())])]
    .filter((d) => d && !hideD.has(d));
  const avoid = prefs.filter((p) => p.kind.startsWith('dislike_')).map((p) => p.value);
  return { cuisines, dishes, avoid };
}

// the user's cuisines, most telling first: saving a lot of Mexican in the Bay Area says less than saving Burmese
export function rankCuisines(
  profile: Record<string, { share?: number; count?: number }>,
  measured: { cuisine: string; share: number }[],
  poolSize: number,
): { cuisine: string; score: number; share: number; base: number }[] {
  const base: Record<string, number> = { ...BASE_CUISINE };
  if (poolSize >= MIN_POOL) for (const m of measured) base[m.cuisine] = m.share;
  const entries = Object.entries(profile).map(([c, v]) => [c, v?.share ?? 0] as const);
  const max = Math.max(0, ...entries.map(([, s]) => s)) || 1;
  return entries
    .map(([c, s], i) => {
      const b = Math.max(0.002, base[c] ?? 0.01);
      return { cuisine: c, share: s, base: b, score: liftScore(s, b, max), i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ i: _i, ...r }) => r);
}

// about 5 km cells: everyone near the same spot shares one cache entry
export function areaKey(lat: number, lng: number): string {
  return `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lng * 20) / 20).toFixed(2)}`;
}

export function boxAround(lat: number, lng: number, radiusM: number): Box {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { low: { latitude: lat - dLat, longitude: lng - dLng }, high: { latitude: lat + dLat, longitude: lng + dLng } };
}

// about 50 km cells: one "what is this place known for" answer per city
export function cityKey(lat: number, lng: number): string {
  return `${(Math.round(lat * 2) / 2).toFixed(1)},${(Math.round(lng * 2) / 2).toFixed(1)}`;
}

export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function areaPrompt(area: string): string {
  return `Someone who travels for food is visiting ${area}.
1. List up to 6 things this place is known for that are hard to find elsewhere: local cuisines, dishes, styles,
   regional food that is strong here (for Beijing: Peking roast duck, zhajiangmian, Hui Muslim food, Xinjiang food).
2. List up to 3 non-local categories this place does better than almost anywhere (for Tokyo: pizza, specialty coffee).
   Leave it empty if nothing stands out. Do not list a category just because it is popular.
3. Size: "major" for a big city with a deep food scene (Beijing, Tokyo, New York), "mid" for a regional city,
   "small" for a town or small city.
4. Up to 8 institutions: restaurants, bakeries, cafes or bars this place is famous for that locals and local food
   writers still consider essential (for New York: Katz's Delicatessen, Russ & Daughters). Skip tourist traps locals
   avoid and chains. Only places you are confident are still open. For a small town, list fewer or none.
Return only JSON, no other text:
{"size": "major", "local": [{"name": "Peking roast duck", "query": "peking roast duck restaurant", "tags": ["peking duck", "roast duck", "beijing", "chinese"]}],
 "strengths": [{"name": "...", "query": "...", "tags": ["..."]}],
 "institutions": [{"name": "Siji Minfu", "why": "a few words on what it is known for"}]}
"query" is a short Google Maps search in English. "tags" are lowercase cuisine words a food app might use for these
places (include the broad cuisine, like "chinese", and regional ones, like "uyghur" or "central asian").
A tag must never name a different cuisine: Native American "Indian tacos" get "native american" and "frybread", not "indian".`;
}

export function parseAreaProfile(text: string): AreaProfile | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[0]);
    const list = (x: unknown, n: number): Specialty[] =>
      (Array.isArray(x) ? x : [])
        .filter((p) => typeof p?.name === 'string' && typeof p?.query === 'string' && p.name.trim() && p.query.trim())
        .slice(0, n)
        .map((p) => ({
          name: String(p.name).trim(),
          query: String(p.query).trim(),
          tags: (Array.isArray(p.tags) ? p.tags : []).filter((t: unknown) => typeof t === 'string').map((t: string) => t.toLowerCase().trim()).filter(Boolean),
        }));
    const size = ['major', 'mid', 'small'].includes(d.size) ? d.size : undefined;
    const institutions = (Array.isArray(d.institutions) ? d.institutions : [])
      .filter((x: { name?: unknown }) => typeof x?.name === 'string' && x.name.trim())
      .slice(0, 8)
      .map((x: { name: string; why?: unknown }) => ({ name: x.name.trim(), why: String(x.why ?? '').trim().slice(0, 160) }));
    const p = { size, local: list(d.local, 6), strengths: list(d.strengths, 3), institutions };
    return p.local.length ? p : null;
  } catch {
    return null;
  }
}

// does one of the user's cuisines ("uyghur/central_asian") match a specialty's tags?
// whole labels only: "indian" must not match "indian tacos"
export function matches(cuisine: string, sp: Specialty): boolean {
  const words = cuisine.toLowerCase().replace(/_/g, ' ').split('/').map((w) => w.trim()).filter(Boolean);
  return words.some((w) => sp.tags.includes(w));
}

// away from home? and if so, what the place is known for (asked once per city, shared)
export async function awayProfile(input: DiscoverInput, deps: DiscoverDeps, trace: Trace = {}): Promise<AreaProfile | null> {
  const home = await deps.home();
  const dist = home ? Math.round(km(home, { lat: input.lat, lng: input.lng })) : null;
  trace.km_from_home = dist;
  if (dist == null || dist < AWAY_KM) {
    trace.away = false;
    return null;
  }
  trace.away = true;
  const ck = cityKey(input.lat, input.lng);
  const have = await deps.getAreaProfile(ck);
  if (have?.size && Array.isArray(have.institutions)) { // profiles saved before size or institutions were asked get asked again once
    trace.city_profile = { city_key: ck, from: 'saved', ...have };
    return have;
  }
  const area = input.area_name || `the area around ${input.lat.toFixed(2)}, ${input.lng.toFixed(2)}`;
  const answer = await deps.claudeText(areaPrompt(area)).catch((e) => `error: ${(e as Error).message}`);
  const p = parseAreaProfile(answer);
  if (p) p.area = area;
  trace.city_profile = p ? { city_key: ck, from: 'asked Claude', ...p } : { city_key: ck, from: 'asked Claude, could not read the answer', answer: answer.slice(0, 2000) };
  if (p) await deps.saveAreaProfile(ck, area, p).catch(() => {});
  return p;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function cityOf(address: string | null | undefined): string {
  const parts = (address ?? '').split(',').map((x) => x.trim());
  return parts.length >= 3 ? parts[parts.length - 3] : parts[0] ?? '';
}

function nice(c: string): string {
  return c.replace(/_/g, ' ').replace(/\//g, ' or ');
}

export function toRow(g: DPlace, itemId: string, source: string, title: string, link: string | null, extra: Partial<CandidateRow>): CandidateRow | null {
  const id = g.id as string | undefined;
  if (!id) return null;
  const loc = (g.location ?? {}) as { latitude?: number; longitude?: number };
  const types = (g.types as string[] | undefined) ?? [];
  const name = ((g.displayName as { text?: string } | undefined)?.text ?? '').trim();
  return {
    item_id: itemId,
    source,
    item_title: title,
    item_link: link,
    name,
    location_hint: cityOf(g.formattedAddress as string),
    mention_type: 'discovery',
    cuisine: null,
    dishes: [],
    what_it_says: '',
    google_place_id: id,
    google_name: name,
    address: (g.formattedAddress as string) ?? null,
    location: loc.latitude != null && loc.longitude != null ? `SRID=4326;POINT(${loc.longitude} ${loc.latitude})` : null,
    categories: types,
    primary_type: (g.primaryType as string) ?? null,
    business_status: (g.businessStatus as string) ?? 'OPERATIONAL',
    maps_uri: (g.googleMapsUri as string) ?? null,
    match_confidence: 'good',
    is_food: types.some((t) => FOOD_D.test(t)),
    in_bay_area: false, // Discover here results stay out of the weekly Bay Area picks; Nearby shows them by distance
    tone: 'neutral',
    ...extra,
  };
}

function quality(rating: number | undefined, count: number | undefined): number {
  if (!rating) return 0.5;
  const k = 30;
  const c = count ?? 0;
  return ((rating * c + 4.2 * k) / (c + k) - 3.8) / 1.2; // about 0 to 1
}

// ---------- institutions: what a city is famous for ----------

// each institution from the city profile, found on Google by name; kept if open, food and well liked.
// Looked up once per area for 30 days (one feed item for all of them), then reused.
export async function findInstitutions(away: AreaProfile, input: DiscoverInput, key: string, known: Set<string>, deps: DiscoverDeps, trace: Trace) {
  const city = away.area ?? input.area_name ?? 'this city';
  const itemId = `here:${key}:g:institutions`;
  const out: { score: Score; info: { id: string; name: string; detail: string } }[] = [];
  const rows: CandidateRow[] = [];
  const t: { name: string; result: string }[] = [];
  trace.institutions = t;
  const reason = (why: string) => `A ${city} institution${why ? `: ${why}` : ''}`;
  if ((await deps.cachedQueries(key, CACHE_DAYS)).has(itemId)) {
    const prev = await deps.existingForArea(key, itemId);
    prev.forEach((p, i) => {
      if (known.has(p.google_place_id)) return void t.push({ name: p.name ?? '', result: 'already on your lists or rated' });
      t.push({ name: p.name ?? '', result: 'kept (reused from the last 30 days)' });
      const why = away.institutions?.find((x) => similar(x.name, p.name ?? ''))?.why ?? '';
      out.push({ score: { google_place_id: p.google_place_id, score: 0.95 - i * 0.02, reason: reason(why) }, info: { id: p.google_place_id, name: p.name ?? '', detail: 'local institution' } });
    });
    return { item: null, searched: 0, rows, places: out };
  }
  // wider than the search radius: a city's institutions are spread around it
  const box = boxAround(input.lat, input.lng, 15000);
  await Promise.all(
    (away.institutions ?? []).map(async (inst, i) => {
      const res = await deps.googleSearch(`${inst.name} ${city}`, box, true).catch(() => [] as DPlace[]);
      const g = res.find((r) => similar(inst.name, ((r.displayName as { text?: string } | undefined)?.text ?? '')));
      const drop = (why: string) => void t.push({ name: inst.name, result: why });
      if (!g?.id) return drop('not found on Google nearby');
      const types = (g.types as string[] | undefined) ?? [];
      const rating = (g.rating as number | undefined) ?? 0;
      if ((g.businessStatus ?? 'OPERATIONAL') !== 'OPERATIONAL') return drop(`not open (${g.businessStatus})`);
      if (!types.some((x) => FOOD_D.test(x))) return drop('not food');
      if (rating && rating < 4.0) return drop(`rating ${rating}, under 4.0`);
      const row = toRow(g, itemId, 'Known locally', `What ${city} is known for`, null, { what_it_says: inst.why ? `${inst.why}.` : '' });
      if (row) rows.push(row);
      if (known.has(g.id as string)) return drop('already on your lists or rated');
      t.push({ name: inst.name, result: 'kept' });
      out.push({ score: { google_place_id: g.id as string, score: Math.round((0.95 - i * 0.02) * 1000) / 1000, reason: reason(inst.why) }, info: { id: g.id as string, name: inst.name, detail: inst.why } });
    }),
  );
  return { item: { item_id: itemId, source: 'Known locally', title: `What ${city} is known for`, link: null }, searched: away.institutions?.length ?? 0, rows, places: out };
}

// ---------- quick: Google ----------

export async function discoverGoogle(input: DiscoverInput, deps: DiscoverDeps, trace: Trace = {}) {
  const key = areaKey(input.lat, input.lng);
  trace.mode = 'google';
  const box = boxAround(input.lat, input.lng, Math.min(Math.max(input.radius_m ?? 6000, 2000), 15000));
  const all = (await deps.topCuisines()).filter((c) => !TOO_BROAD.has(c));
  const away = await awayProfile(input, deps, trace);
  const here = input.area_name ?? 'here';
  trace.your_cuisines = all.slice(0, 8);
  // kind sets how much a result counts (base) and the bar it has to clear (strict = standouts only)
  type Q = { c: string; q: string; label: string; cuisine: string | null; base: number; strict: boolean; local?: boolean; cap?: number; reason: string };
  let queries: Q[];
  if (!away) {
    const cuisines = all.slice(0, 5);
    queries = [
      ...cuisines.map((c, i) => ({ c, q: `${nice(c)} restaurant`, label: `${nice(c)} near ${here}`, cuisine: c, base: 1 - i / 7, strict: false, reason: `${cap(nice(c))}: one of the cuisines you save most` })),
      { c: 'best', q: 'best restaurants', label: 'Well rated nearby', cuisine: null, base: 0.35, strict: false, reason: 'Well rated near you' },
    ];
  } else {
    const specials = [...away.local, ...away.strengths];
    const yoursLocal = all.slice(0, 8).filter((c) => specials.some((sp) => matches(c, sp))).slice(0, 3);
    const other = all.slice(0, 5).find((c) => !yoursLocal.includes(c));
    queries = [
      ...away.local.slice(0, 5).map((sp, i) => ({ c: `local-${slug(sp.name)}`, q: sp.query, label: `${sp.name} in ${here}`, cuisine: sp.name.toLowerCase(), base: 1 - i / 12, strict: false, local: true, reason: `Local specialty: ${sp.name}` })),
      ...yoursLocal.map((c) => ({ c, q: `${nice(c)} restaurant`, label: `${nice(c)} near ${here}`, cuisine: c, base: 1, strict: false, reason: `${cap(nice(c))}: you save a lot of it, and ${input.area_name ?? 'this area'} does it especially well` })),
      ...away.strengths.slice(0, 2).map((sp) => ({ c: `strength-${slug(sp.name)}`, q: sp.query, label: `${sp.name} in ${here}`, cuisine: sp.name.toLowerCase(), base: 0.8, strict: false, reason: `${sp.name}: something ${input.area_name ?? 'this area'} does especially well` })),
      // a non-local standout only in a major food city; a 4.6 rating means little in a small market
      ...(other && away.size === 'major' ? [{ c: `${other}:standout`, q: `${nice(other)} restaurant`, label: `${nice(other)} near ${here}`, cuisine: other, base: 0.5, strict: true, cap: 2, reason: `${cap(nice(other))}: one of the cuisines you save most, and a standout here` }] : []),
    ];
  }
  const known = await deps.knownIds();
  const cached = await deps.cachedQueries(key, CACHE_DAYS);

  const items: { item_id: string; source: string; title: string; link: string | null }[] = [];
  const rows: CandidateRow[] = [];
  const scores = new Map<string, Score>();
  const info = new Map<string, { id: string; name: string; detail: string }>(); // for screening against the user's noes
  let searched = 0;
  const tsearches: Record<string, unknown>[] = [];
  trace.searches = tsearches;

  await Promise.all(
    queries.map(async (Q) => {
      const { c, q } = Q;
      const itemId = `here:${key}:g:${c}`;
      let places: DPlace[] = [];
      const kept: string[] = [];
      const dropped: { name: string; reason: string }[] = [];
      const ts: Record<string, unknown> = { query: q, why: Q.reason, bar: Q.strict ? 'standout only' : Q.local ? 'local specialty' : 'normal', kept, dropped };
      tsearches.push(ts);
      if (cached.has(itemId)) {
        // searched recently for this area: reuse what's in the pool
        const prev = await deps.existingForArea(key, itemId);
        ts.reused_from_last_30_days = true;
        for (const p of prev) if (isChain(p.name ?? '')) dropped.push({ name: p.name ?? '', reason: 'chain' });
        places = prev.filter((p) => !isChain(p.name ?? '')).map((p) => ({ id: p.google_place_id, _cached: true, _name: p.name ?? '' }));
      } else {
        places = await deps.googleSearch(q, box, true).catch((e) => ((ts.error = (e as Error).message), []));
        searched += 1;
        items.push({ item_id: itemId, source: 'Google Maps search', title: Q.label, link: null });
      }
      // a name that shows up twice in one search is a chain (fine for a local specialty: a famous duck house)
      const nameOf = (g: DPlace) => ((g.displayName as { text?: string } | undefined)?.text ?? '').trim().toLowerCase();
      const seen = new Map<string, number>();
      for (const g of places) if (!g._cached) seen.set(nameOf(g), (seen.get(nameOf(g)) ?? 0) + 1);
      ts.results = places.length;
      // a local-specialty search keeps Google's top 8: further down the results drift off topic
      if (Q.local && places.length > 8 && !places[0]?._cached) {
        for (const g of places.slice(8)) dropped.push({ name: ((g.displayName as { text?: string } | undefined)?.text ?? '').trim(), reason: 'beyond the top 8 for a local-specialty search' });
        places = places.slice(0, 8);
      }
      const firstOf = new Set<string>(); // one branch per name in a local-specialty search
      places.forEach((g, rank) => {
        const id = g.id as string;
        const label = ((g.displayName as { text?: string } | undefined)?.text ?? (g._name as string) ?? id ?? '').trim();
        const drop = (reason: string) => void dropped.push({ name: label, reason });
        if (!id) return;
        if (known.has(id)) return drop('already on your lists or rated');
        if (!g._cached) {
          if (isChain(nameOf(g))) return drop('chain');
          if (!Q.local && (seen.get(nameOf(g)) ?? 0) > 1) return drop('same name twice in this search (chain)');
          if (Q.local && firstOf.has(nameOf(g))) return drop('another branch, kept the first');
          firstOf.add(nameOf(g));
          const types = (g.types as string[] | undefined) ?? [];
          const count = (g.userRatingCount as number | undefined) ?? 0;
          if ((g.businessStatus ?? 'OPERATIONAL') !== 'OPERATIONAL') return drop(`not open (${g.businessStatus})`);
          if (!types.some((t) => FOOD_D.test(t))) return drop(`not food (${types.slice(0, 3).join(', ')})`);
          const rating = (g.rating as number | undefined) ?? 0;
          if (count >= 20 && rating < 4.3) return drop(`rating ${rating} from ${count} reviews, under 4.3`);
          // away from home, a non-local cuisine has to be a standout
          if (Q.strict && (count < 150 || rating < 4.6)) return drop(`not a standout: ${rating} from ${count} reviews (needs 4.6+ and 150+)`);
          // away from home, few reviews often means few people use Google there, not a new place
          if (away && count < 20 && !Q.local) return drop(`only ${count} Google reviews, away from home`);
          // away from home, a cuisine you save at home is only a side dish: a couple of standouts at most
          if (Q.cap && kept.length >= Q.cap) return drop(`already have ${Q.cap} from this search`);
          const row = toRow(g, itemId, 'Google Maps search', Q.label, null, {
            cuisine: Q.cuisine,
            what_it_says: count < 20 ? (away ? `Only ${count} reviews on Google.` : `New: ${count} reviews on Google.`) : `${(g.rating as number).toFixed(1)} stars from ${count} reviews on Google.`,
          });
          if (row) rows.push(row);
        }
        if (g._cached && Q.cap && kept.length >= Q.cap) return drop(`already have ${Q.cap} from this search`);
        // fit: stronger kinds and higher in the results score higher; quality from Google rating
        // (a reused search has no rating here, so it gets the middle quality)
        const fit = Q.base * (1 - rank / 25);
        const score = 0.6 * fit + 0.4 * quality(g.rating as number, g.userRatingCount as number);
        const reason = Q.reason;
        kept.push(`${label} (${Math.round(score * 100)})`);
        if (!info.has(id)) {
          const types = ((g.types as string[] | undefined) ?? []).filter((t) => !/^(point_of_interest|establishment|food|restaurant)$/.test(t)).slice(0, 3);
          const stars = g.rating ? `${g.rating} stars, ${g.userRatingCount ?? 0} Google reviews` : '';
          info.set(id, { id, name: label, detail: [Q.cuisine, ...types.map((t) => t.replace(/_/g, ' ')), stars].filter(Boolean).join('; ') });
        }
        const prev = scores.get(id);
        if (!prev || score > prev.score) scores.set(id, { google_place_id: id, score: Math.round(score * 1000) / 1000, reason });
      });
    }),
  );

  // away from home: the places the city is famous for, looked up by name
  if (away?.institutions?.length) {
    const found = await findInstitutions(away, input, key, known, deps, trace);
    if (found.item) {
      items.push(found.item);
      searched += found.searched;
    }
    rows.push(...found.rows);
    for (const x of found.places) {
      info.set(x.score.google_place_id, x.info);
      const prev = scores.get(x.score.google_place_id);
      if (!prev || x.score.score > prev.score) scores.set(x.score.google_place_id, x.score);
    }
  }

  const ranked = await rerank(
    [...scores.values()].map((x) => ({ id: x.google_place_id, name: info.get(x.google_place_id)?.name ?? '', detail: info.get(x.google_place_id)?.detail ?? '', score: x.score, reason: x.reason })),
    deps,
    trace,
  );
  await deps.save(items, rows, ranked, key, 'google');
  trace.kind = 'google';
  trace.result = { searched, reused: queries.length - searched, places: scores.size };
  return { mode: 'google', area: key, away: !!away, searched, places: scores.size };
}

// ---------- slow: the web ----------

export function webPrompt(area: string, cuisines: string[], away?: AreaProfile | null, dislikes: string[] = []): string {
  const noes = dislikes.length
    ? `\nWhen they turned places down, they said: ${dislikes.slice(0, 15).map((d) => `"${d}"`).join('; ')}. Leave out places like those.`
    : '';
  return webPromptBase(area, cuisines, away) + noes + WEB_FORMAT;
}

function webPromptBase(area: string, cuisines: string[], away?: AreaProfile | null): string {
  if (away) {
    return `Find restaurants, cafes, bakeries and bars in or near ${area} for a visitor who travels for food.
Focus on what ${area} is known for and does better than elsewhere: ${[...away.local, ...away.strengths].map((x) => x.name).join(', ')}.
At home they save a lot of ${cuisines.map(nice).join(', ') || 'varied food'}. That reflects where they live, not what they
want here: include those only where ${area} is known for them. Include other non-local food only when the place is a
standout that local food writers single out, or a local take on it. Include the institutions ${area} is famous for
that locals still go to, and mark them "institution": true. Skip chains and tourist traps locals avoid.
Use the local food press, local guides and recent reviews. Places must be open now.`;
  }
  return `Find restaurants, cafes, bakeries and bars in or near ${area} that a visitor with this taste would want to try.
Their favorite cuisines: ${cuisines.map(nice).join(', ') || 'varied'}.
Use the local food press, "best new restaurants" lists, local guides and recent reviews. Prefer places that opened or
got press in the last year, and lesser-known places that fit their cuisines, over famous tourist standbys.
Places must be open now.`;
}

const WEB_FORMAT = `
Return up to 15 places. End your answer with a JSON array in a \`\`\`json block, one object per place:
{"name": "...", "city": "...", "cuisine": "...", "dishes": ["..."],
 "why": "one sentence in your own words on why it fits this person (no quotes from articles)",
 "source": "publication name", "source_title": "article title", "source_url": "..."}`;

export function parseWeb(text: string): { name: string; city: string; cuisine: string; dishes: string[]; why: string; source: string; source_title: string; source_url: string; institution: boolean }[] {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  try {
    const d = JSON.parse(blocks.length ? blocks[blocks.length - 1][1] : text);
    return (Array.isArray(d) ? d : [])
      .filter((p) => typeof p?.name === 'string' && p.name.trim())
      .slice(0, 15)
      .map((p) => ({
        name: String(p.name).trim(),
        city: String(p.city ?? '').trim(),
        cuisine: String(p.cuisine ?? '').trim().toLowerCase(),
        dishes: Array.isArray(p.dishes) ? p.dishes.filter((x: unknown) => typeof x === 'string').slice(0, 6) : [],
        why: String(p.why ?? '').trim().slice(0, 300),
        source: String(p.source ?? 'Web').trim(),
        source_title: String(p.source_title ?? '').trim(),
        source_url: String(p.source_url ?? '').trim(),
        institution: p.institution === true,
      }));
  } catch {
    return [];
  }
}

function similar(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(the|restaurant|cafe|bar)\b/g, '').trim();
  const x = n(a), y = n(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

export async function discoverWeb(input: DiscoverInput, deps: DiscoverDeps, trace: Trace = {}) {
  const key = areaKey(input.lat, input.lng);
  trace.mode = 'web';
  const box = boxAround(input.lat, input.lng, Math.min(Math.max(input.radius_m ?? 6000, 3000), 20000));
  const cached = await deps.cachedQueries(key, CACHE_DAYS);
  const known = await deps.knownIds();
  const cuisines = (await deps.topCuisines()).filter((c) => !TOO_BROAD.has(c)).slice(0, 6);
  const away = await awayProfile(input, deps, trace);
  trace.your_cuisines = cuisines;

  if ([...cached].some((id) => id.startsWith(`here:${key}:w:`))) {
    // the web was searched for this area recently (by anyone): reuse, and score for this user
    const prev = await deps.existingForArea(key, `here:${key}:w:`);
    const fresh = prev.filter((p) => !known.has(p.google_place_id) && !isChain(p.name ?? ''));
    const scores = await rerank(fresh.map((p) => ({ id: p.google_place_id, name: p.name ?? '', detail: [p.cuisine, `from ${p.source}`].filter(Boolean).join('; '), score: 0.55, reason: `From ${p.source}` })), deps, trace);
    await deps.save([], [], scores, key, 'web-cached');
    trace.kind = 'web-cached';
    trace.result = { reused_from_last_30_days: true, places: scores.length };
    return { mode: 'web', area: key, cached: true, places: scores.length };
  }
  const limit = (await deps.webLimit?.().catch(() => null)) ?? WEB_PER_DAY;
  if ((await deps.webRunsToday()) >= limit) {
    trace.kind = 'web-limited';
    trace.limit = limit;
    return { mode: 'web', area: key, places: 0, message: `Web search is limited to ${limit} new areas a day. The quick results are still here.` };
  }

  const dislikes = (await deps.dislikes?.().catch(() => [])) ?? [];
  const prompt = webPrompt(input.area_name || `the area around ${input.lat.toFixed(3)}, ${input.lng.toFixed(3)}`, cuisines, away, dislikes);
  trace.kind = 'web'; // counts toward the daily limit even if a later step fails
  trace.prompt = prompt;
  const { text, searches, queries, pages } = await deps.claudeWeb(prompt);
  const found = parseWeb(text);
  const tfound: { name: string; source: string; url: string; result: string }[] = [];
  trace.claude = { searches, queries: queries ?? [], pages: (pages ?? []).slice(0, 60), answer: text.slice(0, 20000) };
  trace.found = tfound;
  const items: { item_id: string; source: string; title: string; link: string | null }[] = [];
  const rows: CandidateRow[] = [];
  const scores: Score[] = [];
  const webInfo = new Map<string, { name: string; detail: string }>(); // for the rerank
  await Promise.all(
    found.map(async (f, i) => {
      const t = { name: f.name, source: f.source, url: f.source_url, result: '' };
      tfound.push(t);
      const drop = (reason: string) => void (t.result = reason);
      if (!/^https?:\/\//.test(f.source_url)) return drop('no source link');
      const res = await deps.googleSearch(`${f.name} ${f.city}`, box, false).catch(() => []);
      const g = res.find((r) => similar(f.name, ((r.displayName as { text?: string } | undefined)?.text ?? '')));
      if (!g) return drop(`not found on Google in the area (Google had: ${res.slice(0, 3).map((r) => (r.displayName as { text?: string } | undefined)?.text).join(', ') || 'nothing'})`);
      if ((g.businessStatus ?? 'OPERATIONAL') !== 'OPERATIONAL') return drop(`not open (${g.businessStatus})`);
      if (isChain(((g.displayName as { text?: string } | undefined)?.text ?? ''))) return drop('chain');
      const itemId = `here:${key}:w:${f.source_url}`.slice(0, 500);
      if (!items.some((x) => x.item_id === itemId)) items.push({ item_id: itemId, source: f.source, title: f.source_title || f.source, link: f.source_url });
      const row = toRow(g, itemId, f.source, f.source_title || f.source, f.source_url, {
        mention_type: 'list_entry', cuisine: f.cuisine || null, dishes: f.dishes, what_it_says: f.why, tone: 'positive',
      });
      if (!row) return drop('no Google id');
      if (known.has(row.google_place_id)) return drop('already on your lists or rated');
      rows.push(row);
      const liked = !!f.cuisine && cuisines.some((c) => f.cuisine.includes(nice(c)) || nice(c).includes(f.cuisine));
      const local = !!away && [...away.local, ...away.strengths].some((sp) => (!!f.cuisine && matches(f.cuisine, sp)) || f.dishes.some((x) => matches(x, sp)));
      const famous = !!away && f.institution;
      // away from home, a cuisine they save at home only counts where this city is known for it
      const score = 0.75 - i * 0.01 + (liked && (!away || local) ? 0.1 : 0) + (local ? 0.1 : 0) + (famous ? 0.15 : 0);
      const city = away?.area ?? input.area_name ?? 'local';
      const where = away?.area ?? input.area_name ?? 'this area';
      const reason = famous ? `A ${city} institution. From ${f.source}`
        : liked && local ? `${cap(f.cuisine)}: you save a lot of it, and ${where} does it especially well. From ${f.source}`
        : local ? `Local specialty. From ${f.source}`
        : liked && !away ? `${cap(f.cuisine)}: one of the cuisines you save most. From ${f.source}`
        : `From ${f.source}`;
      scores.push({ google_place_id: row.google_place_id, score: Math.round(score * 1000) / 1000, reason });
      webInfo.set(row.google_place_id, { name: f.name, detail: [f.cuisine, f.why, `from ${f.source}`].filter(Boolean).join('; ') });
      t.result = `kept (${Math.round(score * 100)}): ${reason}`;
    }),
  );
  if (!items.length) items.push({ item_id: `here:${key}:w:none`, source: 'Web', title: 'No web results', link: null });
  const ranked = await rerank(scores.map((x) => ({ id: x.google_place_id, name: webInfo.get(x.google_place_id)?.name ?? '', detail: webInfo.get(x.google_place_id)?.detail ?? '', score: x.score, reason: x.reason })), deps, trace);
  await deps.save(items, rows, ranked, key, 'web');
  trace.result = { searches, found: found.length, places: scores.length };
  return { mode: 'web', area: key, searches, places: scores.length };
}

// ---------- onboard.ts ----------

// Onboarding and bulk imports, the server side.
//   taste_read       the user names a few restaurants that show their taste and/or dishes they love;
//                    Claude reads it, each restaurant gets Google matches to confirm. Nothing saved.
//   taste_save       saves the confirmed restaurants as favorites and the dishes and cuisines as stated
//                    likes, creates the user's app_users row if new, writes a starter taste profile so
//                    Discover works right away, and asks the Mac mini to build the full profile and picks.
//   screenshot_list  a screenshot of a list from another app (Beli, Yelp, a notes list): every place on
//                    it, each with Google matches. The app saves the ones the user keeps (like Add a place).
// Pure logic with injected calls so it can be tested; index.ts wires it up.


export type TasteInput = { type: 'taste_read'; text?: string; lat?: number; lng?: number };
export type TastePlace = { name: string; area: string; cuisine: string; candidates: Candidate[] };
export type TasteRead = { places: TastePlace[]; dishes: string[]; cuisines: string[]; dislikes: string[]; message?: string };

export type TasteSaveInput = {
  type: 'taste_save';
  places: { name: string; cuisine?: string; candidate: Candidate; list?: 'favorites' | 'want_to_go' }[]; // favorites unless said
  noes?: { google_place_id: string; name: string }[]; // local places they marked "Not for me" in onboarding
  dishes?: string[];
  cuisines?: string[];
  dislikes?: string[];
  text?: string; // what they wrote, kept with the stated likes
};

export type ShotInput = { type: 'screenshot_list'; image_base64?: string; text?: string; lat?: number; lng?: number }; // a screenshot, or pasted text
export type ShotPlace = { name: string; location_hint: string; note: string; candidates: Candidate[] };
export type ShotResult = { app: string | null; places: ShotPlace[]; message?: string };

export type OnboardDeps = {
  claude: (content: unknown[], noSystem?: boolean) => Promise<string>;
  googleSearch: (query: string, bias?: { lat: number; lng: number }) => Promise<Record<string, unknown>[]>;
};

export const MAX_TASTE_PLACES = 12;
export const MAX_SHOT_PLACES = 40;

// ---------- reading what they like ----------

export const TASTE_PROMPT = `A new user of a restaurant app named a few restaurants that best show their taste
and/or dishes they love. Use only what they wrote; do not add places or dishes.
Answer with JSON only:
{"places": [{"name": "restaurant as named", "area": "neighborhood or city if given, else empty",
             "cuisine": "the restaurant's cuisine if you know it, as a short lowercase label (thai, burmese, uyghur, pizza, ramen), else empty"}],
 "dishes": ["dishes or drinks they love, lowercase"],
 "cuisines": ["cuisines they said they like, lowercase; only ones they stated"],
 "dislikes": ["anything they said they avoid"]}
At most ${MAX_TASTE_PLACES} places.

What they wrote:
`;

const strs = (v: unknown, n: number) =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, n);

export function parseTaste(text: string): Omit<TasteRead, 'places'> & { places: Omit<TastePlace, 'candidates'>[] } {
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const d = JSON.parse(raw);
    const places = (Array.isArray(d.places) ? d.places : [])
      .filter((p: { name?: unknown }) => typeof p?.name === 'string' && p.name.trim())
      .slice(0, MAX_TASTE_PLACES)
      .map((p: { name: string; area?: unknown; cuisine?: unknown }) => ({
        name: p.name.trim(),
        area: typeof p.area === 'string' ? p.area.trim() : '',
        cuisine: typeof p.cuisine === 'string' ? p.cuisine.trim().toLowerCase() : '',
      }));
    return { places, dishes: strs(d.dishes, 20).map((x) => x.toLowerCase()), cuisines: strs(d.cuisines, 10).map((x) => x.toLowerCase()), dislikes: strs(d.dislikes, 10) };
  } catch {
    return { places: [], dishes: [], cuisines: [], dislikes: [] };
  }
}

async function candidatesFor(name: string, hint: string, bias: { lat: number; lng: number } | undefined, deps: OnboardDeps, n = 3) {
  const res = await deps.googleSearch([name, hint].filter(Boolean).join(' '), bias).catch(() => []);
  return res
    .map(toCandidate)
    .filter((c): c is Candidate => !!c)
    .sort((a, b) => Number(b.is_food) - Number(a.is_food) || Number(b.open) - Number(a.open))
    .slice(0, n);
}

export async function tasteRead(input: TasteInput, deps: OnboardDeps): Promise<TasteRead> {
  const text = (input.text ?? '').trim();
  if (!text) return { places: [], dishes: [], cuisines: [], dislikes: [], message: 'Name a few restaurants or dishes first.' };
  const parsed = parseTaste(await deps.claude([{ type: 'text', text: TASTE_PROMPT + text.slice(0, 4000) }], true));
  const bias = typeof input.lat === 'number' && typeof input.lng === 'number' ? { lat: input.lat, lng: input.lng } : undefined;
  const places = await Promise.all(parsed.places.map(async (p) => ({ ...p, candidates: await candidatesFor(p.name, p.area, bias, deps) })));
  const empty = !places.length && !parsed.dishes.length && !parsed.cuisines.length;
  return { ...parsed, places, message: empty ? 'Nothing to go on yet. Try naming a restaurant or a dish.' : undefined };
}

// ---------- the starter profile ----------
// Same shape as profile.py's, so Discover and match.py can use it until profile.py replaces it.
// Weights as in profile.py: a favorite counts 2, a stated cuisine 5, a stated dish 3.

const NOT_CUISINE = new Set(['european', 'asian', 'american', 'breakfast', 'brunch', 'family', 'fast_food', 'fine_dining', 'fusion', 'asian_fusion', 'dessert', 'vegetarian', 'vegan', 'halal', 'lunch', 'dinner', 'buffet', 'seafood_casual']);
const ALIAS: Record<string, string> = {
  chinese_noodle: 'chinese', sushi: 'japanese', ramen: 'japanese', 'south indian': 'indian', south_indian: 'indian',
  hamburger: 'burgers', barbecue: 'bbq', 'middle eastern': 'middle_eastern', uighur: 'uyghur', 'central asian': 'uyghur/central asian',
  uyghur: 'uyghur/central asian', uzbek: 'uyghur/central asian',
};
export function normCuisine(c: string): string {
  const x = (c ?? '').trim().toLowerCase().replace(/-/g, ' ');
  return (ALIAS[x] ?? x).replace(/ /g, '_');
}
const FORMAT_OF: Record<string, string> = {
  coffee_shop: 'coffee', cafe: 'cafe', tea_house: 'tea', bubble_tea_shop: 'tea', bakery: 'bakery', pastry_shop: 'bakery',
  ice_cream_shop: 'dessert', dessert_shop: 'dessert', bar: 'bar', wine_bar: 'bar', cocktail_bar: 'bar', pub: 'bar', brewery: 'bar',
  restaurant: 'restaurant',
};

export function starterProfile(handle: string, s: Omit<TasteSaveInput, 'type'>) {
  const cuisines = new Map<string, number>();
  const formats = new Map<string, number>();
  const dishes = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, w: number) => k && m.set(k, (m.get(k) ?? 0) + w);
  let n = 0;
  for (const p of s.places) {
    if (p.list === 'want_to_go') continue; // wanting to try a place says less than loving one
    n += 2;
    const cats = p.candidate.categories ?? [];
    const fromGoogle = cats.filter((t) => t.endsWith('_restaurant')).map((t) => t.slice(0, -'_restaurant'.length)).filter((t) => !NOT_CUISINE.has(t));
    const labels = new Set([...fromGoogle.map(normCuisine), ...(p.cuisine ? [normCuisine(p.cuisine)] : [])]);
    for (const c of labels) add(cuisines, c, 2);
    const f = cats.map((t) => FORMAT_OF[t]).find(Boolean);
    if (f) add(formats, f, 2);
  }
  for (const c of s.cuisines ?? []) {
    add(cuisines, normCuisine(c), 5);
    n += 5;
  }
  for (const d of s.dishes ?? []) add(dishes, d.toLowerCase(), 3);
  const N = n || 1;
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    version: 3,
    starter: true, // from onboarding; profile.py replaces it
    user_id: handle,
    n_food_places: n,
    n_with_notes: 0,
    regions: {},
    formats: Object.fromEntries(sorted(formats).map(([k, v]) => [k, { count: v, share: Math.round((v / N) * 1000) / 1000 }])),
    cuisines: Object.fromEntries(sorted(cuisines).map(([k, v]) => [k, { count: v, share: Math.round((v / N) * 1000) / 1000 }])),
    dishes: Object.fromEntries(sorted(dishes)),
    sources: [],
    source_types: {},
    sentiments: {},
    negative_or_near_miss: [],
    avoid: [],
    dislikes: { cuisines: [], dishes: [], formats: [], other: s.dislikes ?? [] },
    stated_cuisines: [...new Set((s.cuisines ?? []).map(normCuisine))].sort(),
    n_stated: (s.cuisines?.length ?? 0) + (s.dishes?.length ?? 0) + (s.dislikes?.length ?? 0),
  };
}

// a short handle for the scripts, from the email ("dana.lee@x.com" -> "dana-lee"), made unique
export async function makeHandle(email: string, taken: (h: string) => Promise<boolean>): Promise<string> {
  const base = (email.split('@')[0] ?? 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'user';
  for (let i = 1; i < 50; i++) {
    const h = i === 1 ? base : `${base}-${i}`;
    if (!(await taken(h))) return h;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export function placeRow(uid: string, p: TasteSaveInput['places'][number]) {
  const c = p.candidate;
  return {
    user_id: uid,
    place_key: `onboard:${c.google_place_id}`,
    list_name: p.list === 'want_to_go' ? 'want_to_go' : 'favorites',
    added_via: 'onboard',
    list_set_in_app: true,
    title: p.name,
    google_place_id: c.google_place_id,
    google_name: c.name,
    address: c.address,
    location: c.lat !== null && c.lng !== null ? `SRID=4326;POINT(${c.lng} ${c.lat})` : null,
    categories: c.categories,
    is_food: c.is_food,
    match_confidence: 'good',
    source_type: 'onboard',
  };
}

export function prefRows(uid: string, s: Omit<TasteSaveInput, 'type'>) {
  const raw = (s.text ?? '').slice(0, 2000) || null;
  const rows = [
    ...(s.cuisines ?? []).map((v) => ({ kind: 'cuisine', value: v.toLowerCase() })),
    ...(s.dishes ?? []).map((v) => ({ kind: 'dish', value: v.toLowerCase() })),
    ...(s.dislikes ?? []).map((v) => ({ kind: 'dislike_other', value: v })),
  ];
  const seen = new Set<string>();
  return rows.filter((r) => r.value && !seen.has(`${r.kind}|${r.value}`) && seen.add(`${r.kind}|${r.value}`)).map((r) => ({ user_id: uid, ...r, raw }));
}

// ---------- a screenshot of a list from another app ----------

export const SHOT_PROMPT = `This is a screenshot of a list of restaurants, cafes, bars or food shops, probably from
another app (Beli, Yelp, Google Maps, Instagram, a notes app). List every place on it, in order.
Answer with JSON only:
{"app": "the app it seems to come from, or null",
 "places": [{"name": "place name as shown", "location_hint": "neighborhood or city if shown, else empty",
             "note": "the user's own rating, score or note if shown, else empty"}]}
At most ${MAX_SHOT_PLACES} places. Leave out ads, section headings and the app's own suggestions.`;

export function parseShot(text: string): { app: string | null; places: Omit<ShotPlace, 'candidates'>[] } {
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const d = JSON.parse(raw);
    const places = (Array.isArray(d.places) ? d.places : [])
      .filter((p: { name?: unknown }) => typeof p?.name === 'string' && p.name.trim())
      .slice(0, MAX_SHOT_PLACES)
      .map((p: { name: string; location_hint?: unknown; note?: unknown }) => ({
        name: p.name.trim(),
        location_hint: typeof p.location_hint === 'string' ? p.location_hint.trim() : '',
        note: typeof p.note === 'string' ? p.note.trim() : '',
      }));
    return { app: typeof d.app === 'string' && d.app.trim() ? d.app.trim() : null, places };
  } catch {
    return { app: null, places: [] };
  }
}

export const TEXT_PROMPT = `This is a list of restaurants, cafes, bars or food shops the user pasted (from a notes app,
a message, a spreadsheet, another app). List every place in it, in order.
Answer with JSON only:
{"app": "where the list seems to come from, or null",
 "places": [{"name": "place name", "location_hint": "neighborhood or city if given, else empty",
             "note": "anything the user wrote about it, else empty"}]}
At most ${MAX_SHOT_PLACES} places. Leave out anything that is not a specific place.

The list:
`;

export async function screenshotList(input: ShotInput, deps: OnboardDeps): Promise<ShotResult> {
  const text = (input.text ?? '').trim();
  if (!input.image_base64 && !text) return { app: null, places: [], message: 'Nothing received.' };
  const content = input.image_base64
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image_base64 } }, { type: 'text', text: SHOT_PROMPT }]
    : [{ type: 'text', text: TEXT_PROMPT + text.slice(0, 15000) }];
  const parsed = parseShot(await deps.claude(content, true));
  const bias = typeof input.lat === 'number' && typeof input.lng === 'number' ? { lat: input.lat, lng: input.lng } : undefined;
  const places = await Promise.all(parsed.places.map(async (p) => ({ ...p, candidates: await candidatesFor(p.name, p.location_hint, bias, deps) })));
  return { app: parsed.app, places, message: places.length ? undefined : input.image_base64 ? "Couldn't find a list of places in that screenshot." : "Couldn't find any places in that text." };
}

// ---------- search.ts ----------

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

// ---------- starter.ts ----------

// First run: well-known places near a new user, for them to rate in onboarding
// (Love it / Want to go / Not for me / haven't been). A dozen quick answers tell Discover more than a blank start.

export type StarterInput = { type: 'starter_places'; lat?: number; lng?: number; exclude?: string[] };
export type StarterPlace = Candidate & { rating: number | null; reviews: number | null; kind: string };
type SPlace = Record<string, unknown>;
export type StarterDeps = { googleSearch: (query: string, box: Box, rating: boolean) => Promise<SPlace[]> };

export const STARTER_COUNT = 12;
// restaurants first, then a few cafes, bakeries and bars, so it isn't all dinner spots
const QUERIES = [
  { q: 'popular restaurants', take: 8 },
  { q: 'popular cafes bakeries and bars', take: 4 },
];
const SKIP = /^(point_of_interest|establishment|food|restaurant|store)$/;

// "Thai restaurant", "Bakery": the most specific Google type, in words
export function kindOf(types: string[]): string {
  const t = types.find((x) => !SKIP.test(x)) ?? 'restaurant';
  const s = t.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function starterPlaces(input: StarterInput, deps: StarterDeps): Promise<{ places: StarterPlace[] }> {
  if (typeof input.lat !== 'number' || typeof input.lng !== 'number') return { places: [] };
  const box = boxAround(input.lat, input.lng, 6000);
  const skip = new Set(input.exclude ?? []);
  const lists = await Promise.all(
    QUERIES.map(async ({ q, take }) => {
      const res = await deps.googleSearch(q, box, true).catch(() => [] as SPlace[]);
      return res
        .filter((g) => {
          const name = ((g.displayName as { text?: string } | undefined)?.text ?? '').trim();
          const rating = (g.rating as number | undefined) ?? 0;
          const count = (g.userRatingCount as number | undefined) ?? 0;
          return !!g.id && !skip.has(g.id as string) && !isChain(name) && (g.businessStatus ?? 'OPERATIONAL') === 'OPERATIONAL' && rating >= 4.2 && count >= 150;
        })
        // well known first: the point is places they've likely heard of or been to
        .sort((a, b) => ((b.userRatingCount as number) ?? 0) - ((a.userRatingCount as number) ?? 0))
        .slice(0, take);
    }),
  );
  const seen = new Set<string>();
  const places: StarterPlace[] = [];
  for (const g of lists.flat()) {
    const c = toCandidate(g);
    if (!c || !c.is_food || seen.has(c.google_place_id)) continue;
    seen.add(c.google_place_id);
    places.push({ ...c, rating: (g.rating as number | undefined) ?? null, reviews: (g.userRatingCount as number | undefined) ?? null, kind: kindOf(c.categories) });
  }
  return { places: places.slice(0, STARTER_COUNT) };
}
