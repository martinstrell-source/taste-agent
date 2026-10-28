// Google rating, review count, price level and opening hours for a list of places, through a shared cache.
// Pure logic (no Supabase or network imports) so it can be tested on its own; index.ts wires it up.

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
