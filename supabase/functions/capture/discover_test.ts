// deno test supabase/functions/capture/discover_test.ts
import { deepStrictEqual as eq, ok } from 'node:assert';

import { areaKey, boxAround, type DiscoverDeps, discoverGoogle, discoverWeb, isChain, matches, parseAreaProfile, parseWeb } from './discover.ts';

const P = (id: string, name: string, types: string[], rating = 4.6, count = 120, status = 'OPERATIONAL') => ({
  id, displayName: { text: name }, formattedAddress: `1 Main St, Portland, OR 97201, USA`, location: { latitude: 45.52, longitude: -122.68 },
  types, rating, userRatingCount: count, businessStatus: status,
});

// the city-profile question (the other fast Claude call is the chain and "no" check)
const isArea = (p: string) => p.includes('travels for food is visiting');

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
  eq(saved[0].scores.find((s) => s.google_place_id === 'U1')?.reason, 'Uyghur or central asian: one of the cuisines you save most');
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

const BEIJING = '{"size":"major","local":[{"name":"Peking roast duck","query":"peking roast duck restaurant","tags":["peking duck","roast duck","chinese"]},{"name":"Xinjiang food","query":"xinjiang restaurant","tags":["xinjiang","uyghur","central asian","chinese"]}],"strengths":[]}';

Deno.test('away: local specialties first, your cuisines only if local, others only standouts; profile asked once', async () => {
  const asked: string[] = [];
  const savedProfiles: string[] = [];
  const searches: string[] = [];
  const { d, saved } = deps({
    home: async () => ({ lat: 37.77, lng: -122.25 }),
    claudeText: async (p) => (isArea(p) ? (asked.push(p), 'Sure:\n' + BEIJING) : '[]'),
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
  const a = deps({ home: async () => ({ lat: 37.77, lng: -122.25 }), getAreaProfile: async () => p, claudeText: async (q) => (isArea(q) && asked++, '') });
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 39.9, lng: 116.4 }, a.d);
  const b = deps({ home: async () => ({ lat: 45.4, lng: -122.6 }), claudeText: async (q) => (isArea(q) && asked++, '') });
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
  eq(saved[0].scores[0].reason, 'Local specialty. From Time Out Beijing');
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
  eq(ids, ['D1', 'X1']); // local duck house kept once (few reviews ok); Pizza Hut and the repeated pizza place dropped
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

Deno.test('away: whole-label matching; small town skips the standout search; local searches keep the top 8, one branch each', async () => {
  const town = '{"size":"small","local":[{"name":"Indian tacos","query":"indian taco","tags":["native american","frybread"]}],"strengths":[]}';
  const p = parseAreaProfile(town)!;
  ok(!matches('indian', p.local[0]));
  const searches: string[] = [];
  const many = Array.from({ length: 12 }, (_, i) => P(`T${i}`, i === 1 ? 'Taco Spot' : i === 0 ? 'Taco Spot' : `Place ${i}`, ['restaurant'], 4.5, 50));
  const { d, saved } = deps({
    home: async () => ({ lat: 37.77, lng: -122.25 }),
    getAreaProfile: async () => p,
    topCuisines: async () => ['indian', 'japanese'],
    googleSearch: async (q) => (searches.push(q), q === 'indian taco' ? many : []),
  });
  const trace: Record<string, unknown> = {};
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 44.08, lng: -103.23, area_name: 'Rapid City' }, d, trace);
  eq(searches, ['indian taco']); // no "indian restaurant" as yours-and-local, no standout search in a small town
  eq(saved[0].scores.length, 7); // top 8, minus the second Taco Spot
  const drops = (trace.searches as { dropped: { reason: string }[] }[])[0].dropped.map((x) => x.reason);
  ok(drops.includes('another branch, kept the first') && drops.filter((r) => r.startsWith('beyond the top 8')).length === 4);
});

Deno.test('away: a saved profile without a size is asked again once', async () => {
  let asked = 0;
  const { d } = deps({
    home: async () => ({ lat: 37.77, lng: -122.25 }),
    getAreaProfile: async () => ({ local: [{ name: 'X', query: 'x', tags: ['x'] }], strengths: [] }),
    claudeText: async (q) => (isArea(q) ? (asked++, BEIJING) : '[]'),
  });
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 39.9, lng: 116.4 }, d);
  eq(asked, 1);
});

Deno.test('noes: places like ones the user turned down are left out, with the reason in the trace', async () => {
  let asked = '';
  const { d, saved } = deps({
    dislikes: async () => ['Golden Dragon: looks American Chinese'],
    claudeText: async (p) => ((asked = p), 'Sure: [{"n": 2, "why": "like Golden Dragon", "no": true}]'),
  });
  const trace: Record<string, unknown> = {};
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68 }, d, trace);
  ok(asked.includes('Golden Dragon: looks American Chinese'));
  const flagged = asked.split('\n').find((l) => l.startsWith('2. '))!.slice(3).split(' (')[0];
  const ids = saved[0].scores.map((x) => x.google_place_id);
  const c = deps();
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68 }, c.d);
  eq(ids.length, c.saved[0].scores.length - 1);
  const noes = trace.your_noes as { left_out: { name: string; why: string }[] };
  eq(noes.left_out, [{ name: flagged, why: 'like Golden Dragon' }]);
  eq(ids.length, new Set(ids).size);
});

Deno.test('screen: with no reasons given, Claude still flags chains (and only chains); unreadable answer keeps everything', async () => {
  let asked = '';
  const a = deps({ claudeText: async (p) => ((asked = p), '[{"n": 1, "chain": true, "why": "regional chain"}, {"n": 2, "chain": false, "why": "meh"}]') });
  const trace: Record<string, unknown> = {};
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68 }, a.d, trace);
  ok(asked.includes('"chain"') && !asked.includes('turned suggestions down') && !asked.includes('"no"'));
  const first = asked.split('\n').find((l) => l.startsWith('1. '))!.slice(3).split(' (')[0];
  eq(trace.chains_left_out, [first]);
  const base = deps();
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68 }, base.d);
  eq(a.saved[0].scores.length, base.saved[0].scores.length - 1);
  const b = deps({ dislikes: async () => ['X: too touristy'], claudeText: async () => 'no idea' });
  const c = deps();
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68 }, b.d);
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 45.52, lng: -122.68 }, c.d);
  eq(b.saved[0].scores.length, c.saved[0].scores.length);
});

Deno.test('noes: the web search is told what they turned down', async () => {
  let prompt = '';
  const { d } = deps({
    dislikes: async () => ['Golden Dragon: looks American Chinese'],
    claudeWeb: async (p) => ((prompt = p), { text: '[]', searches: 1 }),
  });
  await discoverWeb({ type: 'discover', mode: 'web', lat: 45.52, lng: -122.68, area_name: 'Portland' }, d);
  ok(prompt.includes('"Golden Dragon: looks American Chinese"') && prompt.includes('Leave out places like those'));
  ok(prompt.trim().endsWith('"source_url": "..."}'));
});

Deno.test('away: the city profile names its institutions; each is found on Google by name and ranked near the top', async () => {
  const asked: string[] = [];
  let savedProfile: Record<string, unknown> | null = null;
  const { d, saved } = deps({
    home: async () => ({ lat: 37.8, lng: -122.27 }), // far from Philadelphia
    getAreaProfile: async () => ({ size: 'major', local: [{ name: 'Cheesesteak', query: 'cheesesteak', tags: ['cheesesteak'] }], strengths: [] }), // older: no institutions
    saveAreaProfile: async (_ck, _n, p) => void (savedProfile = p as unknown as Record<string, unknown>),
    claudeText: async () => '{"size":"major","local":[{"name":"Cheesesteak","query":"cheesesteak","tags":["cheesesteak"]}],"strengths":[],"institutions":[{"name":"Zahav","why":"modern Israeli"},{"name":"Gone Diner","why":"old"},{"name":"Museum Cafe","why":"x"}]}',
    googleSearch: async (q) => {
      asked.push(q);
      if (q.startsWith('Zahav')) return [P('Z1', 'Zahav', ['israeli_restaurant', 'restaurant'], 4.7, 6000)];
      if (q.startsWith('Gone Diner')) return [P('G1', 'Gone Diner', ['diner'], 4.5, 900, 'CLOSED_PERMANENTLY')];
      if (q.startsWith('Museum Cafe')) return [P('M1', 'Museum', ['museum'], 4.8, 9000)];
      return [P('C1', 'Steak Spot', ['sandwich_shop', 'restaurant'], 4.5, 800)];
    },
  });
  const trace: Record<string, unknown> = {};
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 39.95, lng: -75.16, area_name: 'Philadelphia' }, d, trace);
  ok(asked.includes('Zahav Philadelphia'));
  eq((savedProfile as unknown as { institutions: unknown[]; area: string }).area, 'Philadelphia');
  const top = [...saved[0].scores].sort((a, b) => b.score - a.score)[0];
  eq([top.google_place_id, top.reason], ['Z1', 'A Philadelphia institution: modern Israeli']);
  ok(!saved[0].scores.some((x) => ['G1', 'M1'].includes(x.google_place_id)));
  eq((trace.institutions as { name: string; result: string }[]).map((x) => x.result).sort(), ['kept', 'not food', 'not open (CLOSED_PERMANENTLY)']);
  ok(saved[0].items.some((x) => (x as { item_id: string }).item_id.endsWith(':g:institutions')));
});

Deno.test('away: the web search is asked for institutions, and they rank higher', async () => {
  let prompt = '';
  const { d, saved } = deps({
    home: async () => ({ lat: 37.8, lng: -122.27 }),
    getAreaProfile: async () => ({ size: 'major', local: [{ name: 'Cheesesteak', query: 'cheesesteak', tags: ['cheesesteak'] }], strengths: [], institutions: [], area: 'Philadelphia' }),
    claudeWeb: async (p) => ((prompt = p), { text: '```json\n[{"name":"Lardo","city":"Philadelphia","source":"Inquirer","source_url":"https://x.com/a"},{"name":"Zahav","city":"Philadelphia","institution":true,"source":"Inquirer","source_url":"https://x.com/b"}]\n```', searches: 2 }),
    googleSearch: async (q) => (q.startsWith('Zahav') ? [P('Z1', 'Zahav', ['restaurant'])] : [P('W1', 'Lardo', ['restaurant'])]),
  });
  await discoverWeb({ type: 'discover', mode: 'web', lat: 39.95, lng: -75.16, area_name: 'Philadelphia' }, d);
  ok(prompt.includes('institutions Philadelphia is famous for'));
  const s = Object.fromEntries(saved[0].scores.map((x) => [x.google_place_id, x]));
  ok(s.Z1.score > s.W1.score);
  eq(s.Z1.reason, 'A Philadelphia institution. From Inquirer');
});

Deno.test('away: a cuisine saved at home gives at most 2 standouts, and the web search treats it as background', async () => {
  const { d, saved } = deps({
    topCuisines: async () => ['mexican'],
    home: async () => ({ lat: 37.8, lng: -122.27 }),
    getAreaProfile: async () => ({ size: 'major', local: [{ name: 'Bagels', query: 'bagel shop', tags: ['bagels'] }], strengths: [], institutions: [], area: 'New York' }),
    googleSearch: async (q) =>
      q.startsWith('mexican') ? [1, 2, 3, 4, 5].map((n) => P(`M${n}`, `Taqueria ${n}`, ['mexican_restaurant'], 4.7, 900)) : [P('B1', 'Bagel Hole', ['bagel_shop'], 4.6, 1200)],
  });
  const trace: Record<string, unknown> = {};
  await discoverGoogle({ type: 'discover', mode: 'google', lat: 40.7, lng: -74.0, area_name: 'New York' }, d, trace);
  const ids = saved[0].scores.map((x) => x.google_place_id);
  eq(ids.filter((x) => x.startsWith('M')).length, 2);
  eq(saved[0].rows.filter((r) => r.google_place_id.startsWith('M')).length, 2); // the rest aren't stored as picks either
  ok(ids.includes('B1'));

  let prompt = '';
  const w = deps({
    topCuisines: async () => ['mexican'],
    home: async () => ({ lat: 37.8, lng: -122.27 }),
    getAreaProfile: async () => ({ size: 'major', local: [{ name: 'Bagels', query: 'bagel shop', tags: ['bagels'] }], strengths: [], institutions: [], area: 'New York' }),
    claudeWeb: async (p) => ((prompt = p), { text: '```json\n[{"name":"Lardo","city":"New York","cuisine":"mexican","source":"Eater NY","source_url":"https://x.com/a"}]\n```', searches: 1 }),
  });
  await discoverWeb({ type: 'discover', mode: 'web', lat: 40.7, lng: -74.0, area_name: 'New York' }, w.d);
  ok(prompt.includes('That reflects where they live, not what they') && !prompt.includes('Their favorite cuisines'));
  eq([w.saved[0].scores[0].score, w.saved[0].scores[0].reason], [0.75, 'From Eater NY']);
});

Deno.test('chains: regional chains are on the name list', () => {
  ok(isChain('Round Table Pizza') && isChain("Peet's Coffee") && isChain('Mountain Mike’s Pizza') && isChain('In-N-Out Burger'));
  ok(!isChain('Round the Corner Cafe') && !isChain('Tartine'));
});

Deno.test('cuisines: ranked by how much more often you save them than is common, not raw count', async () => {
  const { rankCuisines } = await import('./discover.ts');
  const prof = { mexican: { share: 0.2 }, japanese: { share: 0.12 }, burmese: { share: 0.05 } };
  // a big enough pool: measured base rates are used
  const big = rankCuisines(prof, [{ cuisine: 'mexican', share: 0.18 }, { cuisine: 'japanese', share: 0.04 }, { cuisine: 'burmese', share: 0.004 }], 2000);
  eq(big.map((r) => r.cuisine), ['burmese', 'japanese', 'mexican']);
  // a small pool: the built-in base rates (Mexican 10%) are used instead of the measured ones
  const small = rankCuisines(prof, [{ cuisine: 'mexican', share: 0.5 }], 20);
  eq(small.find((r) => r.cuisine === 'mexican')?.base, 0.1);
  eq(rankCuisines({}, [], 0), []);
});

Deno.test('rerank: Claude scores each place for this person with a specific reason; institutions keep theirs; a failed call keeps the ranking', async () => {
  const { rerank } = await import('./discover.ts');
  const items = [
    { id: 'A', name: 'Noodle Bar', detail: 'chinese', score: 0.5, reason: 'Chinese: one of the cuisines you save most' },
    { id: 'B', name: 'Old Oyster House', detail: 'seafood', score: 0.95, reason: 'A Boston institution: oysters since 1826' },
    { id: 'C', name: 'Plain Grill', detail: 'american', score: 0.8, reason: 'Well rated near you' },
  ];
  let asked = '';
  const d = deps({
    taste: async () => 'Top cuisines: chinese, burmese\nFavorites include: Xi\'an Famous',
    claudeText: async (p) => ((asked = p), '[{"n":1,"fit":90,"why":"Hand-pulled noodles, like Xi\'an Famous you saved"},{"n":2,"fit":60,"why":"Classic oysters"},{"n":3,"fit":10,"why":"Generic grill"}]'),
  }).d;
  const trace: Record<string, unknown> = {};
  const out = Object.fromEntries((await rerank(items, d, trace)).map((x) => [x.google_place_id, x]));
  ok(asked.includes("Favorites include: Xi'an Famous") && asked.includes('3. Plain Grill (american)'));
  eq(out.A.reason, "Hand-pulled noodles, like Xi'an Famous you saved");
  eq(out.A.score, 0.78); // 0.3 * 0.5 + 0.7 * 0.9
  eq(out.B.reason, 'A Boston institution: oysters since 1826');
  ok(out.A.score > out.C.score); // Discover had Plain Grill higher; the fit for this person wins
  eq((trace.rerank as { name: string }[])[0].name, 'Noodle Bar'); // 0.78 vs 0.705 for the oyster house

  const failed = await rerank(items, deps({ claudeText: async () => 'sorry' }).d, {});
  eq(failed.map((x) => [x.google_place_id, x.score, x.reason]), items.map((x) => [x.id, x.score, x.reason]));
});
