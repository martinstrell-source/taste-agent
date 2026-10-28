// Supabase Edge Function "place-details": Google rating, review count, price and opening hours for
// the places the app is showing, through the shared place_ratings cache.
// The Google key stays here (secret GOOGLE_MAPS_API_KEY); the app never sees it.
//
// Request (signed-in users only):  POST { "ids": ["<google place id>", ...], "hours": true|false }
// Response: { "places": { "<id>": { rating, review_count, price_level, opening_hours } }, "fetched": n }
import { createClient } from 'npm:@supabase/supabase-js@2';

import { type CachedRow, placeDetails } from './core.ts';

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

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function fetchGoogle(id: string, withHours: boolean) {
  const fields = ['rating', 'userRatingCount', 'priceLevel'];
  if (withHours) fields.push('regularOpeningHours', 'utcOffsetMinutes');
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
    headers: { 'X-Goog-Api-Key': GOOGLE_KEY!, 'X-Goog-FieldMask': fields.join(',') },
  });
  if (!r.ok) throw new Error(`Google ${r.status}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!GOOGLE_KEY || !SECRET || !PUBLIC) {
    return Response.json({ error: 'Function is missing GOOGLE_MAPS_API_KEY or Supabase keys' }, { status: 500, headers: cors });
  }
  // only signed-in users of the app
  const asUser = createClient(URL_, PUBLIC, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: who } = await asUser.auth.getUser();
  if (!who?.user) return Response.json({ error: 'Not signed in' }, { status: 401, headers: cors });

  let body: { ids?: unknown; hours?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Send JSON: {"ids": [...]}' }, { status: 400, headers: cors });
  }

  const admin = createClient(URL_, SECRET, { auth: { persistSession: false } });
  const result = await placeDetails(body.ids, body.hours === true, {
    readCache: async (ids) => {
      if (!ids.length) return [];
      const { data, error } = await admin
        .from('place_ratings')
        .select('google_place_id, rating, user_rating_count, price_level, opening_hours, fetched_at, hours_fetched_at')
        .in('google_place_id', ids);
      if (error) throw error;
      return (data ?? []) as CachedRow[];
    },
    writeCache: async (rows) => {
      const { error } = await admin.from('place_ratings').upsert(rows, { onConflict: 'google_place_id' });
      if (error) throw error;
    },
    fetchGoogle,
  });
  return Response.json(result, { headers: cors });
});
