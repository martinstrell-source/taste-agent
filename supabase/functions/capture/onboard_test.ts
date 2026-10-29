// deno test supabase/functions/capture/onboard_test.ts
import { deepStrictEqual as eq, ok } from 'node:assert';

import { makeHandle, normCuisine, parseShot, parseTaste, placeRow, prefRows, screenshotList, starterProfile, tasteRead } from './onboard.ts';

const G = (id: string, name: string, types: string[], status = 'OPERATIONAL') => ({
  id, displayName: { text: name }, formattedAddress: '1 Main St, Oakland, CA', location: { latitude: 37.8, longitude: -122.27 }, types, businessStatus: status,
});

Deno.test('taste_read: Claude reads restaurants and dishes; each restaurant gets Google matches, food first', async () => {
  const asked: string[] = [];
  const r = await tasteRead({ type: 'taste_read', text: 'Kin Khao and Burma Superstar. I love khao soi.', lat: 37.8, lng: -122.27 }, {
    claude: async (c) => (asked.push(JSON.stringify(c)), 'Sure:\n```json\n{"places":[{"name":"Kin Khao","area":"SF","cuisine":"Thai"},{"name":"Burma Superstar","area":"","cuisine":"burmese"}],"dishes":["Khao Soi"],"cuisines":[],"dislikes":[]}\n```'),
    googleSearch: async (q) => (q.startsWith('Kin Khao') ? [G('P1', 'Kin Khao Parking', ['parking']), G('K1', 'Kin Khao', ['thai_restaurant'])] : [G('B1', 'Burma Superstar', ['burmese_restaurant', 'restaurant'])]),
  });
  ok(asked[0].includes('Kin Khao and Burma Superstar'));
  eq(r.places.map((p) => [p.name, p.cuisine, p.candidates[0].google_place_id]), [['Kin Khao', 'thai', 'K1'], ['Burma Superstar', 'burmese', 'B1']]);
  eq(r.dishes, ['khao soi']);
  eq(r.message, undefined);
});

Deno.test('taste_read: empty text and nothing found get a message', async () => {
  const deps = { claude: async () => '{"places":[],"dishes":[],"cuisines":[],"dislikes":[]}', googleSearch: async () => [] };
  ok((await tasteRead({ type: 'taste_read', text: ' ' }, deps)).message);
  ok((await tasteRead({ type: 'taste_read', text: 'hmm' }, deps)).message);
  eq(parseTaste('not json').places, []);
});

Deno.test('starter profile: cuisines from Google types and Claude labels (favorites 2, stated 5), dishes 3, same shape as profile.py', () => {
  const p = starterProfile('dana', {
    places: [
      { name: 'Kin Khao', cuisine: 'thai', candidate: { google_place_id: 'K1', name: 'Kin Khao', address: null, lat: 1, lng: 2, categories: ['thai_restaurant', 'restaurant'], is_food: true, open: true } },
      { name: 'Kashgar', cuisine: 'uyghur', candidate: { google_place_id: 'U1', name: 'Kashgar', address: null, lat: 1, lng: 2, categories: ['chinese_restaurant', 'halal_restaurant'], is_food: true, open: true } },
    ],
    cuisines: ['Burmese'],
    dishes: ['Khao Soi'],
  });
  eq(Object.keys(p.cuisines), ['burmese', 'thai', 'chinese', 'uyghur/central_asian']);
  eq(p.cuisines.thai.count, 2); // Google and Claude agree: counted once
  eq(p.dishes, { 'khao soi': 3 });
  eq(p.n_food_places, 9);
  eq(p.starter, true);
  eq(p.stated_cuisines, ['burmese']);
  eq(normCuisine('Central Asian'), 'uyghur/central_asian');
});

Deno.test('rows: favorites from onboarding; stated likes deduped; handle unique', async () => {
  const c = { google_place_id: 'K1', name: 'Kin Khao', address: 'a', lat: 37.8, lng: -122.4, categories: ['thai_restaurant'], is_food: true, open: true };
  const r = placeRow('u1', { name: 'Kin Khao', candidate: c });
  eq([r.place_key, r.list_name, r.added_via, r.location], ['onboard:K1', 'favorites', 'onboard', 'SRID=4326;POINT(-122.4 37.8)']);
  eq(prefRows('u1', { places: [], dishes: ['Khao Soi', 'khao soi'], cuisines: ['thai'] }).map((x) => `${x.kind}:${x.value}`), ['cuisine:thai', 'dish:khao soi']);
  const taken = new Set(['dana-lee', 'dana-lee-2']);
  eq(await makeHandle('Dana.Lee@example.com', async (h) => taken.has(h)), 'dana-lee-3');
});

Deno.test('screenshot list: every place in order, with the app it came from and the user\'s own score', async () => {
  const r = await screenshotList({ type: 'screenshot_list', image_base64: 'xx' }, {
    claude: async () => '{"app":"Beli","places":[{"name":"Nopa","location_hint":"SF","note":"8.7"},{"name":"Delfina","location_hint":"","note":""}]}',
    googleSearch: async (q) => [G(q.split(' ')[0], q.split(' ')[0], ['restaurant'])],
  });
  eq(r.app, 'Beli');
  eq(r.places.map((p) => [p.name, p.note, p.candidates[0].google_place_id]), [['Nopa', '8.7', 'Nopa'], ['Delfina', '', 'Delfina']]);
  eq(parseShot('nope').places, []);
  ok((await screenshotList({ type: 'screenshot_list' }, { claude: async () => '', googleSearch: async () => [] })).message);
});

Deno.test('pasted list: text goes to Claude with the list prompt, same result shape', async () => {
  let sent = '';
  const r = await screenshotList({ type: 'screenshot_list', text: 'Nopa\nDelfina (Mission)' }, {
    claude: async (c) => ((sent = JSON.stringify(c)), '{"app":null,"places":[{"name":"Nopa"},{"name":"Delfina","location_hint":"Mission"}]}'),
    googleSearch: async (q) => [G(q.split(' ')[0], q.split(' ')[0], ['restaurant'])],
  });
  ok(sent.includes('The list:') && sent.includes('Delfina (Mission)'));
  eq(r.places.map((p) => p.name), ['Nopa', 'Delfina']);
});
