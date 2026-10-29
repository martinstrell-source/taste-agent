// deno test supabase/functions/capture/search_test.ts
import { deepStrictEqual as eq, ok } from 'node:assert';

import { autocompleteBody, placeGet, placeSearch } from './search.ts';

Deno.test('search: food and drink only, near the map, short queries skipped', async () => {
  let sent: Record<string, unknown> = {};
  const deps = {
    autocomplete: async (b: Record<string, unknown>) => {
      sent = b;
      return {
        suggestions: [
          { placePrediction: { placeId: 'K1', types: ['thai_restaurant', 'restaurant', 'food'], structuredFormat: { mainText: { text: 'Kin Khao' }, secondaryText: { text: 'Mason St, San Francisco' } } } },
          { placePrediction: { placeId: 'S1', types: ['street_address'], structuredFormat: { mainText: { text: 'Kingston St' } } } },
          { queryPrediction: { text: { text: 'kin khao menu' } } },
          { placePrediction: { placeId: 'C1', types: ['cafe'], text: { text: 'Kinfolk Coffee' } } },
        ],
      };
    },
    details: async () => null,
  };
  const r = await placeSearch({ type: 'place_search', q: 'kin', lat: 37.8, lng: -122.3, session: 'tok' }, deps);
  eq(r.hits, [
    { google_place_id: 'K1', name: 'Kin Khao', detail: 'Mason St, San Francisco' },
    { google_place_id: 'C1', name: 'Kinfolk Coffee', detail: '' },
  ]);
  eq([sent.sessionToken, (sent.locationBias as { circle: { radius: number } }).circle.radius], ['tok', 50000]);
  eq((await placeSearch({ type: 'place_search', q: 'ki' }, deps)).hits, []);
  ok(!('locationBias' in autocompleteBody({ type: 'place_search', q: 'x' })));
});

Deno.test('get: location, types and rating for the chosen place', async () => {
  const r = await placeGet({ type: 'place_get', id: 'K1', session: 'tok' }, {
    autocomplete: async () => ({}),
    details: async (id, s) => ({ id, displayName: { text: `Kin Khao ${s}` }, location: { latitude: 37.78, longitude: -122.41 }, types: ['thai_restaurant'], rating: 4.5, userRatingCount: 900, priceLevel: 'PRICE_LEVEL_EXPENSIVE' }),
  });
  eq([r.place?.name, r.place?.lat, r.place?.rating, r.place?.open], ['Kin Khao tok', 37.78, 4.5, true]);
  eq((await placeGet({ type: 'place_get' }, { autocomplete: async () => ({}), details: async () => null })).place, null);
});
