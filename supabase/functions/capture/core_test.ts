// deno test supabase/functions/capture/core_test.ts
import { deepStrictEqual as eq, ok } from 'node:assert';

import { capture, type Deps, isMapsUrl, pageText, parseClaude, parseMapsUrl } from './core.ts';

const g = (id: string, name: string, types: string[], status = 'OPERATIONAL') => ({
  id, displayName: { text: name }, formattedAddress: `${name} St, Oakland, CA`, location: { latitude: 37.8, longitude: -122.27 }, types, businessStatus: status,
});

function deps(over: Partial<Deps> = {}) {
  const calls: { claude: unknown[][]; google: { q: string; bias?: unknown }[] } = { claude: [], google: [] };
  const d: Deps = {
    fetchPage: async (url) => ({ finalUrl: url, status: 200, html: '<html><head><title>Best new spots</title><meta property="og:site_name" content="Oaklandside"></head><body>' + 'Great food. '.repeat(40) + '<p>ITSUMO opened in the Laurel.</p></body></html>' }),
    claude: async (c) => {
      calls.claude.push(c);
      return '```json\n{"source":{"type":"publication","name":"Oaklandside"},"places":[{"name":"ITSUMO","location_hint":"Laurel, Oakland","note":"New Japanese bistro.","dishes":["ramen"]}]}\n```';
    },
    googleSearch: async (q, bias) => {
      calls.google.push({ q, bias });
      return [g('X1', 'ITSUMO Parking', ['parking']), g('X2', 'ITSUMO', ['japanese_restaurant', 'restaurant']), g('X3', 'Itsumo Closed', ['restaurant'], 'CLOSED_PERMANENTLY'), g('X4', 'Other', ['restaurant'])];
    },
    shorthand: [{ term: 'A', name: 'Alex', type: 'person' }],
    ...over,
  };
  return { d, calls };
}

Deno.test('maps links: name and point from the URL, no Claude', async () => {
  ok(isMapsUrl('https://maps.app.goo.gl/abc123'));
  ok(isMapsUrl('https://www.google.com/maps/place/Taste+of+Urumqi/@37.79,-122.41,17z'));
  ok(!isMapsUrl('https://oaklandside.org/x'));
  eq(parseMapsUrl('https://www.google.com/maps/place/Taste+of+Urumqi/@37.79,-122.41,17z/data=x'), { name: 'Taste of Urumqi', lat: 37.79, lng: -122.41 });
  const { d, calls } = deps({ fetchPage: async () => ({ finalUrl: 'https://www.google.com/maps/place/Taste+of+Urumqi/@37.79,-122.41,17z', status: 200, html: '' }) });
  const r = await capture({ type: 'link', url: 'https://maps.app.goo.gl/abc123' }, d);
  eq(calls.claude.length, 0);
  eq(calls.google[0], { q: 'Taste of Urumqi', bias: { lat: 37.79, lng: -122.41 } });
  eq(r.places[0].name, 'Taste of Urumqi');
});

Deno.test('article link: Claude reads the page, food and open places first, at most 3 matches', async () => {
  const { d, calls } = deps();
  const r = await capture({ type: 'link', url: 'https://oaklandside.org/new', lat: 37.77, lng: -122.25 }, d);
  eq(r.source, { type: 'publication', name: 'Oaklandside', url: 'https://oaklandside.org/new' });
  eq(r.places[0].dishes, ['ramen']);
  eq(r.places[0].candidates.map((c) => c.google_place_id), ['X2', 'X4', 'X3']);
  eq(calls.google[0], { q: 'ITSUMO Laurel, Oakland', bias: { lat: 37.77, lng: -122.25 } });
  ok(String((calls.claude[0][0] as { text: string }).text).includes('"A" means Alex'));
});

Deno.test('blocked or empty pages ask for text or a screenshot', async () => {
  const { d, calls } = deps({ fetchPage: async (u) => ({ finalUrl: u, status: 403, html: 'Login' }) });
  const r = await capture({ type: 'link', url: 'https://www.instagram.com/p/xyz' }, d);
  eq(r.places, []);
  ok(r.message?.includes('Instagram'));
  eq(calls.claude.length, 0);
});

Deno.test('friend tip: the friend is the source; photo: image goes to Claude', async () => {
  const { d, calls } = deps();
  const r = await capture({ type: 'friend', friend: 'Alex', text: 'go to ITSUMO, get the ramen' }, d);
  eq(r.source, { type: 'person', name: 'Alex', url: null });
  const p = await capture({ type: 'photo', image_base64: 'AAAA', lat: 37.8, lng: -122.27 }, d);
  eq((calls.claude[1][0] as { type: string }).type, 'image');
  eq(p.source.type, 'publication'); // Claude said publication (a screenshot of an article)
  const empty = await capture({ type: 'text', text: '   ' }, d);
  ok(empty.message);
});

Deno.test('parsing: page text and messy Claude answers', () => {
  const t = pageText('<title>Fish &amp; Chips</title><script>x()</script><p>Hello&nbsp;there</p>');
  eq(t.title, 'Fish & Chips');
  ok(t.text.includes('Hello there') && !t.text.includes('x()'));
  eq(parseClaude('Sure! {"places":[{"name":" A "},{"note":"no name"}]} hope that helps').places.map((p) => p.name), ['A']);
  eq(parseClaude('not json').places, []);
});

Deno.test('bill: items and totals, never payment details', async () => {
  const { readBill, parseBill } = await import('./core.ts');
  const b = parseBill('```json\n{"restaurant":"Taste of Urumqi","date":"2026-10-27","items":[{"name":"Lamb skewers","qty":2,"price":17.0},{"name":"Big plate chicken","price":24.954},{"name":"VISA XXXX1234"},{"name":"  "}],"subtotal":41.95,"tax":4.2,"tip":8,"total":54.15}\n```');
  eq(b.items.map((i) => i.name), ['Lamb skewers', 'Big plate chicken']);
  eq(b.items[1], { name: 'Big plate chicken', qty: 1, price: 24.95 });
  eq([b.date, b.total], ['2026-10-27', 54.15]);
  eq(parseBill('garbage').items, []);
  const { d, calls } = deps({ claude: async (c) => { calls.claude.push(c); return '{"items":[{"name":"Laghman","price":16}]}'; } });
  const r = await readBill({ type: 'bill', image_base64: 'AAAA' }, d);
  eq(r.bill.items[0].name, 'Laghman');
  eq((calls.claude[0][0] as { type: string }).type, 'image');
});

Deno.test('TikTok: caption and creator from the embed info; Instagram asks for a screenshot', async () => {
  const { capture, parseTikTok } = await import('./core.ts');
  const calls: string[] = [];
  const deps = {
    fetchPage: async (u: string) => {
      calls.push(u);
      return { finalUrl: u, status: 200, html: JSON.stringify({ title: 'Best hand-pulled noodles in Oakland at Noodle House #oakland', author_name: 'eatsbyjo' }) };
    },
    claude: async () => '{"source":{"type":"creator","name":"eatsbyjo"},"places":[{"name":"Noodle House","location_hint":"Oakland","note":"hand-pulled noodles","dishes":["hand-pulled noodles"]}]}',
    googleSearch: async () => [{ id: 'N1', displayName: { text: 'Noodle House' }, types: ['chinese_restaurant'], businessStatus: 'OPERATIONAL' }],
  };
  const r = await capture({ type: 'link', url: 'https://www.tiktok.com/@eatsbyjo/video/123' }, deps as never);
  ok(calls[0].startsWith('https://www.tiktok.com/oembed?url='));
  eq([r.source.name, r.places[0].name, r.places[0].candidates[0].google_place_id], ['eatsbyjo on TikTok', 'Noodle House', 'N1']);
  const ig = await capture({ type: 'link', url: 'https://www.instagram.com/p/abc/' }, deps as never);
  ok(ig.message?.includes('screenshot') && ig.places.length === 0);
  eq(parseTikTok('nope'), null);
});
