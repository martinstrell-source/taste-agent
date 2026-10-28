// deno test supabase/functions/capture/discover_test.ts
import { deepStrictEqual as eq, ok } from 'node:assert';

import { areaKey, boxAround, type DiscoverDeps, discoverGoogle, discoverWeb, parseWeb } from './discover.ts';

const P = (id: string, name: string, types: string[], rating = 4.6, count = 120, status = 'OPERATIONAL') => ({
  id, displayName: { text: name }, formattedAddress: `1 Main St, Portland, OR 97201, USA`, location: { latitude: 45.52, longitude: -122.68 },
  types, rating, userRatingCount: count, businessStatus: status,
});

function deps(over: Partial<DiscoverDeps> = {}) {
  const saved: { items: unknown[]; rows: { google_place_id: string; in_bay_area: boolean; item_id: string }[]; scores: { google_place_id: string; score: number; reason: string }[]; mode: string }[] = [];
  const searches: string[] = [];
  const d: DiscoverDeps = {
    topCuisines: async () => ['uyghur/central_asian', 'american', 'japanese', 'korean'],
    knownIds: async () => new Set(['SAVED']),
    cachedQueries: async () => new Set(),
    webRunsToday: async () => 0,
    googleSearch: async (q) => {
      searches.push(q);
      if (q.startsWith('uyghur')) return [P('U1', 'Kashgar Kitchen', ['restaurant']), P('SAVED', 'Already Saved', ['restaurant']), P('LOW', 'Meh', ['restaurant'], 3.9, 300)];
      if (q.startsWith('japanese')) return [P('J1', 'Sushi Place', ['japanese_restaurant']), P('U1', 'Kashgar Kitchen', ['restaurant']), P('PARK', 'Garage', ['parking'])];
      if (q.startsWith('Lardo')) return [P('W1', 'Lardo', ['sandwich_shop', 'restaurant'])];
      return [P('B1', 'Best Spot', ['restaurant'], 4.8, 2000), P('CLOSED', 'Gone', ['restaurant'], 4.8, 50, 'CLOSED_PERMANENTLY')];
    },
    claudeWeb: async () => ({ text: 'Here you go.\n```json\n[{"name":"Lardo","city":"Portland","cuisine":"sandwiches","why":"Big pork sandwiches.","source":"Eater Portland","source_title":"Best sandwiches","source_url":"https://pdx.eater.com/x"},{"name":"No Link","city":"Portland","source_url":""}]\n```', searches: 4 }),
    save: async (items, rows, scores, _key, mode) => void saved.push({ items, rows, scores, mode }),
    existingForArea: async () => [{ google_place_id: 'W1', cuisine: 'sandwiches', source: 'Eater Portland' }],
    ...over,
  };
  return { d, saved, searches };
}

Deno.test('area key and box', () => {
  eq(areaKey(45.5231, -122.6765), '45.50,-122.70');
  const b = boxAround(45.5, -122.7, 5000);
  ok(b.low.latitude < 45.5 && b.high.latitude > 45.5 && b.low.longitude < -122.7 && b.high.longitude > -122.7);
});

Deno.test('google: top cuisines (not broad ones), skips saved, low-rated, closed and non-food; one score per place', async () => {
  const { d, saved, searches } = deps();
  const r = await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68, area_name: 'Portland' }, d);
  ok(!searches.some((q) => q.startsWith('american')));
  ok(searches.includes('uyghur or central asian restaurant') && searches.includes('best restaurants'));
  const ids = saved[0].scores.map((s) => s.google_place_id).sort();
  eq(ids, ['B1', 'J1', 'U1']);
  ok(saved[0].rows.every((x) => !x.in_bay_area && x.item_id.startsWith('here:45.50,-122.70:g:')));
  eq(saved[0].scores.find((s) => s.google_place_id === 'U1')?.reason, 'Uyghur or central asian, one of your top cuisines');
  eq(r.places, 3);
});

Deno.test('google: a recently searched area reuses the pool instead of searching', async () => {
  const { d, searches } = deps({ cachedQueries: async () => new Set(['here:45.50,-122.70:g:japanese', 'here:45.50,-122.70:g:best']) });
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68 }, d);
  ok(!searches.includes('japanese restaurant') && !searches.includes('best restaurants'));
  ok(searches.includes('korean restaurant'));
});

Deno.test('web: Claude finds, Google confirms; daily limit; cached areas reuse', async () => {
  const { d, saved } = deps();
  const r = await discoverWeb({ type: 'discover', mode: 'web', lat: 45.52, lng: -122.68, area_name: 'Portland, Oregon' }, d);
  eq(r.places, 1);
  eq(saved[0].mode, 'web');
  eq(saved[0].scores[0].reason, 'From Eater Portland');
  const limited = await discoverWeb({ type: 'discover', mode: 'web', lat: 45.52, lng: -122.68 }, deps({ webRunsToday: async () => 3 }).d);
  ok(limited.message?.includes('limited'));
  const c = deps({ cachedQueries: async () => new Set(['here:45.50,-122.70:w:https://pdx.eater.com/x']) });
  const cached = await discoverWeb({ type: 'discover', mode: 'web', lat: 45.52, lng: -122.68 }, c.d);
  eq([cached.cached, c.saved[0].mode], [true, 'web-cached']);
});

Deno.test('parseWeb: tolerant of chatter, skips nameless entries', () => {
  eq(parseWeb('x ```json\n[{"name":"A","source_url":"https://a"},{"city":"B"}]\n```').map((p) => p.name), ['A']);
  eq(parseWeb('nothing'), []);
});
