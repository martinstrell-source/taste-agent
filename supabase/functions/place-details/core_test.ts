// deno test supabase/functions/place-details/core_test.ts
import { deepStrictEqual as assertEquals } from 'node:assert';

import { type CachedRow, placeDetails } from './core.ts';

const NOW = new Date('2026-10-27T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const ID_A = 'ChIJAAAAAAAAAAAAAAAA';
const ID_B = 'ChIJBBBBBBBBBBBBBBBB';
const ID_C = 'ChIJCCCCCCCCCCCCCCCC';

function setup(cache: CachedRow[], fail: string[] = []) {
  const calls: string[] = [];
  const written: CachedRow[] = [];
  return {
    calls,
    written,
    deps: {
      now: NOW,
      readCache: async (ids: string[]) => cache.filter((r) => ids.includes(r.google_place_id)),
      writeCache: async (rows: CachedRow[]) => void written.push(...rows),
      fetchGoogle: async (id: string, withHours: boolean) => {
        calls.push(`${id}:${withHours}`);
        if (fail.includes(id)) throw new Error('Google 500');
        return {
          rating: 4.5, userRatingCount: 120, priceLevel: 'PRICE_LEVEL_MODERATE',
          ...(withHours ? { regularOpeningHours: { periods: [] }, utcOffsetMinutes: -420 } : {}),
        };
      },
    },
  };
}

Deno.test('fresh cache is used, stale and missing are fetched', async () => {
  const cache: CachedRow[] = [
    { google_place_id: ID_A, rating: 4.1, user_rating_count: 50, price_level: null, opening_hours: null, fetched_at: days(5), hours_fetched_at: null },
    { google_place_id: ID_B, rating: 3.9, user_rating_count: 10, price_level: null, opening_hours: null, fetched_at: days(40), hours_fetched_at: null },
  ];
  const t = setup(cache);
  const r = await placeDetails([ID_A, ID_B, ID_C, ID_A, 'bad id!', 7], false, t.deps);
  assertEquals(t.calls, [`${ID_B}:false`, `${ID_C}:false`]);
  assertEquals(r.places[ID_A].rating, 4.1);
  assertEquals(r.places[ID_B].rating, 4.5);
  assertEquals(r.places[ID_C].price_level, 'PRICE_LEVEL_MODERATE');
  assertEquals(r.fetched, 2);
  assertEquals(Object.keys(r.places).length, 3);
});

Deno.test('hours are fetched when asked and older than a week', async () => {
  const cache: CachedRow[] = [
    { google_place_id: ID_A, rating: 4.1, user_rating_count: 50, price_level: null, opening_hours: { old: true }, fetched_at: days(1), hours_fetched_at: days(2) },
    { google_place_id: ID_B, rating: 4.1, user_rating_count: 50, price_level: null, opening_hours: null, fetched_at: days(1), hours_fetched_at: days(9) },
  ];
  const t = setup(cache);
  const r = await placeDetails([ID_A, ID_B], true, t.deps);
  assertEquals(t.calls, [`${ID_B}:true`]);
  assertEquals((r.places[ID_B].opening_hours as { utcOffsetMinutes: number }).utcOffsetMinutes, -420);
  assertEquals(r.places[ID_A].opening_hours, { old: true });
});

Deno.test('a Google failure keeps the cached value and is reported', async () => {
  const cache: CachedRow[] = [
    { google_place_id: ID_A, rating: 4.1, user_rating_count: 50, price_level: null, opening_hours: null, fetched_at: days(60), hours_fetched_at: null },
  ];
  const t = setup(cache, [ID_A, ID_C]);
  const r = await placeDetails([ID_A, ID_C], false, t.deps);
  assertEquals(r.failed, [ID_A, ID_C]);
  assertEquals(r.places[ID_A].rating, 4.1);
  assertEquals(r.places[ID_C], undefined);
  assertEquals(t.written.length, 0);
});

Deno.test('at most 40 ids per request; junk input is ignored', async () => {
  const t = setup([]);
  const ids = Array.from({ length: 60 }, (_, i) => `ChIJ${String(i).padStart(16, '0')}`);
  const r = await placeDetails(ids, false, t.deps);
  assertEquals(t.calls.length, 40);
  assertEquals(Object.keys(r.places).length, 40);
  assertEquals((await placeDetails('nope', false, setup([]).deps)).places, {});
});
