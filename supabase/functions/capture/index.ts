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
import { type Box, type DiscoverDeps, type DiscoverInput, discoverGoogle, discoverWeb } from './discover.ts';

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
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    searches += d.usage?.server_tool_use?.web_search_requests ?? 0;
    text = (d.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    if (d.stop_reason !== 'pause_turn') break;
    body.messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: d.content }];
  }
  return { text, searches };
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
  if (!['link', 'text', 'photo', 'friend', 'bill', 'discover'].includes(input?.type)) {
    return Response.json({ error: 'type must be link, text, photo, friend, bill or discover' }, { status: 400, headers: cors });
  }
  if ((input.image_base64?.length ?? 0) > 7_000_000) {
    return Response.json({ error: 'Photo too large' }, { status: 413, headers: cors });
  }

  // the user's own shorthand ("A" = Alex) helps Claude read their notes and friends' names
  const admin = createClient(URL_, SECRET, { auth: { persistSession: false } });
  const { data: sh } = await admin.from('user_shorthand').select('term, name, type').eq('user_id', who.user.id);

  try {
    if ((input as unknown as DiscoverInput).type === 'discover') {
      const d = input as unknown as DiscoverInput;
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number') {
        return Response.json({ error: 'lat and lng are required' }, { status: 400, headers: cors });
      }
      const uid = who.user.id;
      const ddeps: DiscoverDeps = {
        topCuisines: async () => {
          const { data } = await admin.from('user_profiles').select('profile').eq('user_id', uid).maybeSingle();
          const prof = typeof data?.profile === 'string' ? JSON.parse(data.profile) : data?.profile;
          return Object.keys(prof?.cuisines ?? {});
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
          const { count } = await admin.from('discover_runs').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('kind', 'web').gte('created_at', since);
          return count ?? 0;
        },
        googleSearch: googleInBox,
        claudeWeb,
        existingForArea: async (_key, prefix) => {
          const { data } = await admin.from('candidates').select('google_place_id, cuisine, source').like('item_id', `${prefix}%`).not('google_place_id', 'is', null);
          return (data ?? []) as { google_place_id: string; cuisine: string | null; source: string }[];
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
          if (mode === 'web') await admin.from('discover_runs').insert({ user_id: uid, area_key: key, kind: 'web' });
        },
      };
      const out = d.mode === 'web' ? await discoverWeb(d, ddeps) : await discoverGoogle(d, ddeps);
      return Response.json(out, { headers: cors });
    }
    const deps = { fetchPage, claude, googleSearch, shorthand: sh ?? [] };
    const result = input.type === 'bill' ? await readBill(input, deps) : await capture(input, deps);
    return Response.json(result, { headers: cors });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502, headers: cors });
  }
});
