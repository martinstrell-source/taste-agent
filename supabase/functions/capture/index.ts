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

import { capture, type Input, readBill, SYSTEM } from './core.ts';
import { type GetInput, placeGet, placeSearch, type SearchInput } from './search.ts';
import { type StarterInput, starterPlaces } from './starter.ts';
import { makeHandle, placeRow, prefRows, screenshotList, type ShotInput, starterProfile, type TasteInput, tasteRead, type TasteSaveInput } from './onboard.ts';
import { type AreaProfile, areaKey, type Box, type DiscoverDeps, type DiscoverInput, discoverGoogle, discoverWeb, editedTaste, type Pref, rankCuisines, type Trace } from './discover.ts';

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
