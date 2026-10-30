// deno test supabase/functions/capture/starter_test.ts
import { deepStrictEqual as eq } from 'node:assert';

import { kindOf, starterPlaces } from './starter.ts';

const G = (id: string, name: string, types: string[], rating: number, count: number, status = 'OPERATIONAL') => ({
  id, displayName: { text: name }, formattedAddress: '1 Main St', location: { latitude: 37.8, longitude: -122.3 }, types, rating, userRatingCount: count, businessStatus: status,
});

Deno.test('starter: well-known, well-rated, open, not chains or excluded; restaurants then cafes and bars; no repeats', async () => {
  const asked: string[] = [];
  const r = await starterPlaces({ type: 'starter_places', lat: 37.8, lng: -122.3, exclude: ['X'] }, {
    googleSearch: async (q) => {
      asked.push(q);
      return q.includes('restaurants')
        ? [G('A', 'Small', ['thai_restaurant', 'restaurant'], 4.8, 200), G('B', 'Big', ['pizza_restaurant'], 4.5, 3000), G('C', 'Low', ['restaurant'], 4.0, 900),
           G('D', 'New', ['restaurant'], 4.9, 40), G('E', 'Gone', ['restaurant'], 4.7, 800, 'CLOSED_PERMANENTLY'), G('F', 'Starbucks', ['cafe'], 4.5, 900), G('X', 'Mine', ['restaurant'], 4.6, 500)]
        : [G('K', 'Kiln', ['bakery', 'cafe'], 4.6, 700), G('B', 'Big', ['pizza_restaurant'], 4.5, 3000), G('P', 'Park', ['park'], 4.8, 5000)];
    },
  });
  eq(asked.length, 2);
  eq(r.places.map((p) => [p.google_place_id, p.kind, p.reviews]), [['B', 'Pizza restaurant', 3000], ['A', 'Thai restaurant', 200], ['K', 'Bakery', 700]]);
  eq((await starterPlaces({ type: 'starter_places' }, { googleSearch: async () => [] })).places, []);
  eq(kindOf(['point_of_interest', 'food']), 'Restaurant');
});
