// First run: well-known places near a new user, for them to rate in onboarding
// (Love it / Want to go / Not for me / haven't been). A dozen quick answers tell Discover more than a blank start.
import { type Candidate, toCandidate } from './core.ts';
import { type Box, boxAround, isChain } from './discover.ts';

export type StarterInput = { type: 'starter_places'; lat?: number; lng?: number; exclude?: string[] };
export type StarterPlace = Candidate & { rating: number | null; reviews: number | null; kind: string };
type Place = Record<string, unknown>;
export type StarterDeps = { googleSearch: (query: string, box: Box, rating: boolean) => Promise<Place[]> };

export const STARTER_COUNT = 12;
// restaurants first, then a few cafes, bakeries and bars, so it isn't all dinner spots
const QUERIES = [
  { q: 'popular restaurants', take: 8 },
  { q: 'popular cafes bakeries and bars', take: 4 },
];
const SKIP = /^(point_of_interest|establishment|food|restaurant|store)$/;

// "Thai restaurant", "Bakery": the most specific Google type, in words
export function kindOf(types: string[]): string {
  const t = types.find((x) => !SKIP.test(x)) ?? 'restaurant';
  const s = t.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function starterPlaces(input: StarterInput, deps: StarterDeps): Promise<{ places: StarterPlace[] }> {
  if (typeof input.lat !== 'number' || typeof input.lng !== 'number') return { places: [] };
  const box = boxAround(input.lat, input.lng, 6000);
  const skip = new Set(input.exclude ?? []);
  const lists = await Promise.all(
    QUERIES.map(async ({ q, take }) => {
      const res = await deps.googleSearch(q, box, true).catch(() => [] as Place[]);
      return res
        .filter((g) => {
          const name = ((g.displayName as { text?: string } | undefined)?.text ?? '').trim();
          const rating = (g.rating as number | undefined) ?? 0;
          const count = (g.userRatingCount as number | undefined) ?? 0;
          return !!g.id && !skip.has(g.id as string) && !isChain(name) && (g.businessStatus ?? 'OPERATIONAL') === 'OPERATIONAL' && rating >= 4.2 && count >= 150;
        })
        // well known first: the point is places they've likely heard of or been to
        .sort((a, b) => ((b.userRatingCount as number) ?? 0) - ((a.userRatingCount as number) ?? 0))
        .slice(0, take);
    }),
  );
  const seen = new Set<string>();
  const places: StarterPlace[] = [];
  for (const g of lists.flat()) {
    const c = toCandidate(g);
    if (!c || !c.is_food || seen.has(c.google_place_id)) continue;
    seen.add(c.google_place_id);
    places.push({ ...c, rating: (g.rating as number | undefined) ?? null, reviews: (g.userRatingCount as number | undefined) ?? null, kind: kindOf(c.categories) });
  }
  return { places: places.slice(0, STARTER_COUNT) };
}
