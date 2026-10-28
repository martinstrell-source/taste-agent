// ONE-FILE VERSION for pasting into the Supabase dashboard editor (Edge Functions > Deploy a new function).
// Generated from index.ts + core.ts; edit those, not this.

// Supabase Edge Function "place-details": Google rating, review count, price and opening hours for
// the places the app is showing, through the shared place_ratings cache.
// The Google key stays here (secret GOOGLE_MAPS_API_KEY); the app never sees it.
//
// Request (signed-in users only):  POST { "ids": ["<google place id>", ...], "hours": true|false }
// Response: { "places": { "<id>": { rating, review_count, price_level, opening_hours } }, "fetched": n }
import { createClient } from 'npm:@supabase/supabase-js@2';

// Google rating, review count, price level and opening hours for a list of places, through a shared cache.

export const MAX_IDS = 40;
export const RATING_DAYS = 30; // ratings and price change slowly
export const HOURS_DAYS = 7; // hours change more often

export type CachedRow = {
  google_place_id: string;
  rating: number | null;
  user_rating_count: number | null;
  price_level: string | null;
  opening_hours: unknown | null;
  fetched_at: string | null;
  hours_fetched_at: string | null;
};

export type Details = {
  rating: number | null;
  review_count: number | null;
  price_level: string | null;
  opening_hours: unknown | null;
};

export type Deps = {
  readCache: (ids: string[]) => Promise<CachedRow[]>;
  writeCache: (rows: CachedRow[]) => Promise<void>;
  fetchGoogle: (id: string, withHours: boolean) => Promise<Record<string, unknown>>;
  now?: Date;
};

const ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

function olderThan(ts: string | null, days: number, now: Date): boolean {
  return !ts || now.getTime() - new Date(ts).getTime() > days * 86_400_000;
}

export async function placeDetails(rawIds: unknown, withHours: boolean, deps: Deps) {
  const now = deps.now ?? new Date();
  const ids = Array.isArray(rawIds)
    ? [...new Set(rawIds.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))].slice(0, MAX_IDS)
    : [];
  const cached = new Map((await deps.readCache(ids)).map((r) => [r.google_place_id, r]));
  const updates: CachedRow[] = [];
  const failed: string[] = [];

  for (const id of ids) {
    const row = cached.get(id);
    const needRating = olderThan(row?.fetched_at ?? null, RATING_DAYS, now);
    const needHours = withHours && olderThan(row?.hours_fetched_at ?? null, HOURS_DAYS, now);
    if (!needRating && !needHours) continue;
    try {
      const g = await deps.fetchGoogle(id, withHours);
      const ts = now.toISOString();
      const hours = g.regularOpeningHours
        ? { ...(g.regularOpeningHours as object), utcOffsetMinutes: g.utcOffsetMinutes ?? null }
        : null;
      const next: CachedRow = {
        google_place_id: id,
        rating: (g.rating as number) ?? null,
        user_rating_count: (g.userRatingCount as number) ?? null,
        price_level: (g.priceLevel as string) ?? null,
        opening_hours: withHours ? hours : (row?.opening_hours ?? null),
        fetched_at: ts,
        hours_fetched_at: withHours ? ts : (row?.hours_fetched_at ?? null),
      };
      updates.push(next);
      cached.set(id, next);
    } catch (_e) {
      failed.push(id); // keep whatever the cache had
    }
  }
  if (updates.length) await deps.writeCache(updates);

  const places: Record<string, Details> = {};
  for (const id of ids) {
    const r = cached.get(id);
    if (!r) continue;
    places[id] = {
      rating: r.rating,
      review_count: r.user_rating_count,
      price_level: r.price_level,
      opening_hours: r.opening_hours,
    };
  }
  return { places, fetched: updates.length, failed };
}

// ---------- function ----------


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
