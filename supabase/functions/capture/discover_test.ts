// deno test supabase/functions/capture/discover_test.ts
import { deepStrictEqual as eq, ok } from 'node:assert';

import { areaKey, boxAround, type DiscoverDeps, discoverGoogle, discoverWeb, isChain, matches, parseAreaProfile, parseWeb } from './discover.ts';

const P = (id: string, name: string, types: string[], rating = 4.6, count = 120, status = 'OPERATIONAL') => ({
  id, displayName: { text: name }, formattedAddress: `1 Main St, Portland, OR 97201, USA`, location: { latitude: 45.52, longitude: -122.68 },
  types, rating, userRatingCount: count, businessStatus: status,
});

function deps(over: Partial<DiscoverDeps> = {}) {
  const saved: { items: unknown[]; rows: { google_place_id: string; in_bay_area: boolean; item_id: string; what_it_says?: string }[]; scores: { google_place_id: string; score: number; reason: string }[]; mode: string }[] = [];
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
    home: async () => null,
    getAreaProfile: async () => null,
    saveAreaProfile: async () => {},
    claudeText: async () => '',
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

const BEIJING = '{"local":[{"name":"Peking roast duck","query":"peking roast duck restaurant","tags":["peking duck","roast duck","chinese"]},{"name":"Xinjiang food","query":"xinjiang restaurant","tags":["xinjiang","uyghur","central asian","chinese"]}],"strengths":[]}';

Deno.test('away: local specialties first, your cuisines only if local, others only standouts; profile asked once', async () => {
  const asked: string[] = [];
  const savedProfiles: string[] = [];
  const searches: string[] = [];
  const { d, saved } = deps({
    home: async () => ({ lat: 37.77, lng: -122.25 }),
    claudeText: async (p) => (asked.push(p), 'Sure:\n' + BEIJING),
    saveAreaProfile: async (k) => void savedProfiles.push(k),
    googleSearch: async (q) => {
      searches.push(q);
      if (q.startsWith('peking')) return [P('D1', 'Duck House', ['chinese_restaurant'])];
      if (q.startsWith('japanese')) return [P('J1', 'Ok Sushi', ['japanese_restaurant'], 4.5, 400), P('J2', 'Great Sushi', ['japanese_restaurant'], 4.8, 900)];
      return [];
    },
  });
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 39.9, lng: 116.4, area_name: 'Beijing' }, d);
  eq(asked.length, 1);
  eq(savedProfiles, ['40.0,116.5']);
  ok(searches.includes('peking roast duck restaurant') && searches.includes('xinjiang restaurant'));
  ok(searches.includes('uyghur or central asian restaurant')); // yours and local
  ok(!searches.includes('korean restaurant') && !searches.includes('best restaurants'));
  const ids = saved[0].scores.map((s) => s.google_place_id).sort();
  eq(ids, ['D1', 'J2']); // ordinary sushi dropped, standout kept
  eq(saved[0].scores.find((s) => s.google_place_id === 'D1')?.reason, 'Local specialty: Peking roast duck');
  ok(saved[0].scores.find((s) => s.google_place_id === 'D1')!.score > saved[0].scores.find((s) => s.google_place_id === 'J2')!.score);
});

Deno.test('away: a cached city profile is reused; near home nothing is asked', async () => {
  let asked = 0;
  const p = parseAreaProfile(BEIJING)!;
  const a = deps({ home: async () => ({ lat: 37.77, lng: -122.25 }), getAreaProfile: async () => p, claudeText: async () => (asked++, '') });
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 39.9, lng: 116.4 }, a.d);
  const b = deps({ home: async () => ({ lat: 45.4, lng: -122.6 }), claudeText: async () => (asked++, '') });
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68 }, b.d);
  eq(asked, 0);
  ok(b.searches.includes('best restaurants'));
});

Deno.test('away web: prompt names the specialties; local places get a boost and reason', async () => {
  let prompt = '';
  const { d, saved } = deps({
    home: async () => ({ lat: 37.77, lng: -122.25 }),
    getAreaProfile: async () => parseAreaProfile(BEIJING),
    claudeWeb: async (p) => {
      prompt = p;
      return { text: '```json\n[{"name":"Lardo","city":"Beijing","cuisine":"roast duck","source":"Time Out Beijing","source_url":"https://x"}]\n```', searches: 2 };
    },
  });
  await discoverWeb({ type: 'discover', mode: 'web', lat: 39.9, lng: 116.4, area_name: 'Beijing' }, d);
  ok(prompt.includes('Peking roast duck') && prompt.includes('standout'));
  eq(saved[0].scores[0].reason, 'Local specialty; from Time Out Beijing');
});

Deno.test('matches and parseAreaProfile', () => {
  const p = parseAreaProfile(BEIJING)!;
  ok(matches('uyghur/central_asian', p.local[1]));
  ok(!matches('japanese', p.local[0]));
  eq(parseAreaProfile('no json'), null);
  eq(parseAreaProfile('{"local":[]}'), null);
});

Deno.test('chains: listed chains and repeated names skipped; away, few reviews only from local specialties', async () => {
  ok(isChain('Pizza Hut (Wangfujing)') && isChain('McDonald’s') && !isChain('Pizzeria Mozza'));
  const { d, saved } = deps({
    home: async () => ({ lat: 37.77, lng: -122.25 }),
    getAreaProfile: async () => parseAreaProfile(BEIJING),
    topCuisines: async () => ['pizza', 'korean'],
    googleSearch: async (q) => {
      if (q.startsWith('peking')) return [P('D1', 'Quanjude', ['chinese_restaurant'], 4.2, 8), P('D2', 'Quanjude', ['chinese_restaurant'], 4.2, 6)];
      if (q.startsWith('xinjiang')) return [P('X1', 'Few Reviews Kebab', ['restaurant'], 4.9, 3)];
      if (q.startsWith('pizza')) return [P('PH', 'Pizza Hut', ['pizza_restaurant'], 4.9, 900), P('GP', 'Gung Ho Pizza', ['pizza_restaurant'], 4.7, 300), P('GP2', 'Gung Ho Pizza', ['pizza_restaurant'], 4.7, 200)];
      return [];
    },
  });
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 39.9, lng: 116.4, area_name: 'Beijing' }, d);
  const ids = saved[0].scores.map((s) => s.google_place_id).sort();
  eq(ids, ['D1', 'D2', 'X1']); // local duck house kept (repeat ok, few reviews ok); Pizza Hut and the repeated pizza place dropped
  eq(saved[0].rows.find((r) => r.google_place_id === 'D1')?.what_it_says, 'Only 8 reviews on Google.');
});

Deno.test('chains: near home, a name twice in one search is skipped', async () => {
  const { d, saved } = deps({
    googleSearch: async (q) => (q.startsWith('korean') ? [P('K1', 'bb.q Chicken', ['restaurant']), P('K2', 'bb.q Chicken', ['restaurant']), P('K3', 'Han Il Kwan', ['korean_restaurant'])] : []),
  });
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68 }, d);
  eq(saved[0].scores.map((s) => s.google_place_id), ['K3']);
});

Deno.test('trace: google run records each search, kept places and every drop with its reason', async () => {
  const trace: Record<string, unknown> = {};
  const { d } = deps();
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68, area_name: 'Portland' }, d, trace);
  eq([trace.mode, trace.kind, trace.away], ['google', 'google', false]);
  const s = (trace.searches as { query: string; kept: string[]; dropped: { name: string; reason: string }[] }[]);
  const uy = s.find((x) => x.query.startsWith('uyghur'))!;
  ok(uy.kept[0].startsWith('Kashgar Kitchen'));
  eq(uy.dropped.map((x) => x.reason).sort(), ['already on your lists or rated', 'rating 3.9 from 300 reviews, under 4.3']);
  const best = s.find((x) => x.query === 'best restaurants')!;
  ok(best.dropped.some((x) => x.name === 'Gone' && x.reason.startsWith('not open')));
  const jp = s.find((x) => x.query.startsWith('japanese'))!;
  ok(jp.dropped.some((x) => x.name === 'Garage' && x.reason.startsWith('not food')));
  const out = Deno.env.get('TRACE_OUT');
  if (out) Deno.writeTextFileSync(`${out}/google.json`, JSON.stringify(trace));
});

Deno.test('trace: web run records what Claude searched, the pages, the answer, and each place it named', async () => {
  const trace: Record<string, unknown> = {};
  const { d } = deps({
    home: async () => ({ lat: 37.77, lng: -122.25 }),
    getAreaProfile: async () => parseAreaProfile(BEIJING),
    claudeWeb: async () => ({
      text: '```json\n[{"name":"Lardo","city":"Portland","cuisine":"sandwiches","source":"Eater","source_url":"https://e/x"},{"name":"Nowhere Cafe","city":"Portland","source":"Blog","source_url":"https://b/y"},{"name":"No Link","source_url":""}]\n```',
      searches: 2, queries: ['best new portland restaurants', 'portland sandwiches'], pages: [{ url: 'https://e/x', title: 'Best' }],
    }),
  });
  await discoverWeb({ type: 'discover', mode: 'web', lat: 45.52, lng: -122.68, area_name: 'Portland' }, d, trace);
  eq([trace.kind, trace.away], ['web', true]);
  eq((trace.claude as { queries: string[] }).queries.length, 2);
  const f = trace.found as { name: string; result: string }[];
  ok(f.find((x) => x.name === 'Lardo')!.result.startsWith('kept'));
  ok(f.find((x) => x.name === 'Nowhere Cafe')!.result.startsWith('not found on Google'));
  eq(f.find((x) => x.name === 'No Link')!.result, 'no source link');
  eq((trace.city_profile as { from: string }).from, 'saved');
  const out = Deno.env.get('TRACE_OUT');
  if (out) Deno.writeTextFileSync(`${out}/web.json`, JSON.stringify(trace));
});

Deno.test('trace: a web run over the daily limit is marked, not counted', async () => {
  const trace: Record<string, unknown> = {};
  await discoverWeb({ type: 'discover', mode: 'web', lat: 45.52, lng: -122.68 }, deps({ webRunsToday: async () => 3 }).d, trace);
  eq(trace.kind, 'web-limited');
});

Deno.test('web limit: a per-user limit replaces the default', async () => {
  const t1: Record<string, unknown> = {};
  await discoverWeb({ type: 'discover', mode: 'web', lat: 45.52, lng: -122.68 }, deps({ webRunsToday: async () => 3, webLimit: async () => 10 }).d, t1);
  eq(t1.kind, 'web');
  const t2: Record<string, unknown> = {};
  const r = await discoverWeb({ type: 'discover', mode: 'web', lat: 45.52, lng: -122.68 }, deps({ webRunsToday: async () => 10, webLimit: async () => 10 }).d, t2);
  eq([t2.kind, r.message?.includes('limited to 10')], ['web-limited', true]);
});
