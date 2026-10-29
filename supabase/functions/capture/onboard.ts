// Onboarding and bulk imports, the server side.
//   taste_read       the user names a few restaurants that show their taste and/or dishes they love;
//                    Claude reads it, each restaurant gets Google matches to confirm. Nothing saved.
//   taste_save       saves the confirmed restaurants as favorites and the dishes and cuisines as stated
//                    likes, creates the user's app_users row if new, writes a starter taste profile so
//                    Discover works right away, and asks the Mac mini to build the full profile and picks.
//   screenshot_list  a screenshot of a list from another app (Beli, Yelp, a notes list): every place on
//                    it, each with Google matches. The app saves the ones the user keeps (like Add a place).
// Pure logic with injected calls so it can be tested; index.ts wires it up.

import { type Candidate, toCandidate } from './core.ts';

export type TasteInput = { type: 'taste_read'; text?: string; lat?: number; lng?: number };
export type TastePlace = { name: string; area: string; cuisine: string; candidates: Candidate[] };
export type TasteRead = { places: TastePlace[]; dishes: string[]; cuisines: string[]; dislikes: string[]; message?: string };

export type TasteSaveInput = {
  type: 'taste_save';
  places: { name: string; cuisine?: string; candidate: Candidate }[];
  dishes?: string[];
  cuisines?: string[];
  dislikes?: string[];
  text?: string; // what they wrote, kept with the stated likes
};

export type ShotInput = { type: 'screenshot_list'; image_base64?: string; lat?: number; lng?: number };
export type ShotPlace = { name: string; location_hint: string; note: string; candidates: Candidate[] };
export type ShotResult = { app: string | null; places: ShotPlace[]; message?: string };

export type OnboardDeps = {
  claude: (content: unknown[], noSystem?: boolean) => Promise<string>;
  googleSearch: (query: string, bias?: { lat: number; lng: number }) => Promise<Record<string, unknown>[]>;
};

export const MAX_TASTE_PLACES = 12;
export const MAX_SHOT_PLACES = 30;

// ---------- reading what they like ----------

export const TASTE_PROMPT = `A new user of a restaurant app named a few restaurants that best show their taste
and/or dishes they love. Use only what they wrote; do not add places or dishes.
Answer with JSON only:
{"places": [{"name": "restaurant as named", "area": "neighborhood or city if given, else empty",
             "cuisine": "the restaurant's cuisine if you know it, as a short lowercase label (thai, burmese, uyghur, pizza, ramen), else empty"}],
 "dishes": ["dishes or drinks they love, lowercase"],
 "cuisines": ["cuisines they said they like, lowercase; only ones they stated"],
 "dislikes": ["anything they said they avoid"]}
At most ${MAX_TASTE_PLACES} places.

What they wrote:
`;

const strs = (v: unknown, n: number) =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, n);

export function parseTaste(text: string): Omit<TasteRead, 'places'> & { places: Omit<TastePlace, 'candidates'>[] } {
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const d = JSON.parse(raw);
    const places = (Array.isArray(d.places) ? d.places : [])
      .filter((p: { name?: unknown }) => typeof p?.name === 'string' && p.name.trim())
      .slice(0, MAX_TASTE_PLACES)
      .map((p: { name: string; area?: unknown; cuisine?: unknown }) => ({
        name: p.name.trim(),
        area: typeof p.area === 'string' ? p.area.trim() : '',
        cuisine: typeof p.cuisine === 'string' ? p.cuisine.trim().toLowerCase() : '',
      }));
    return { places, dishes: strs(d.dishes, 20).map((x) => x.toLowerCase()), cuisines: strs(d.cuisines, 10).map((x) => x.toLowerCase()), dislikes: strs(d.dislikes, 10) };
  } catch {
    return { places: [], dishes: [], cuisines: [], dislikes: [] };
  }
}

async function candidatesFor(name: string, hint: string, bias: { lat: number; lng: number } | undefined, deps: OnboardDeps, n = 3) {
  const res = await deps.googleSearch([name, hint].filter(Boolean).join(' '), bias).catch(() => []);
  return res
    .map(toCandidate)
    .filter((c): c is Candidate => !!c)
    .sort((a, b) => Number(b.is_food) - Number(a.is_food) || Number(b.open) - Number(a.open))
    .slice(0, n);
}

export async function tasteRead(input: TasteInput, deps: OnboardDeps): Promise<TasteRead> {
  const text = (input.text ?? '').trim();
  if (!text) return { places: [], dishes: [], cuisines: [], dislikes: [], message: 'Name a few restaurants or dishes first.' };
  const parsed = parseTaste(await deps.claude([{ type: 'text', text: TASTE_PROMPT + text.slice(0, 4000) }], true));
  const bias = typeof input.lat === 'number' && typeof input.lng === 'number' ? { lat: input.lat, lng: input.lng } : undefined;
  const places = await Promise.all(parsed.places.map(async (p) => ({ ...p, candidates: await candidatesFor(p.name, p.area, bias, deps) })));
  const empty = !places.length && !parsed.dishes.length && !parsed.cuisines.length;
  return { ...parsed, places, message: empty ? 'Nothing to go on yet. Try naming a restaurant or a dish.' : undefined };
}

// ---------- the starter profile ----------
// Same shape as profile.py's, so Discover and match.py can use it until profile.py replaces it.
// Weights as in profile.py: a favorite counts 2, a stated cuisine 5, a stated dish 3.

const NOT_CUISINE = new Set(['european', 'asian', 'american', 'breakfast', 'brunch', 'family', 'fast_food', 'fine_dining', 'fusion', 'asian_fusion', 'dessert', 'vegetarian', 'vegan', 'halal', 'lunch', 'dinner', 'buffet', 'seafood_casual']);
const ALIAS: Record<string, string> = {
  chinese_noodle: 'chinese', sushi: 'japanese', ramen: 'japanese', 'south indian': 'indian', south_indian: 'indian',
  hamburger: 'burgers', barbecue: 'bbq', 'middle eastern': 'middle_eastern', uighur: 'uyghur', 'central asian': 'uyghur/central asian',
  uyghur: 'uyghur/central asian', uzbek: 'uyghur/central asian',
};
export function normCuisine(c: string): string {
  const x = (c ?? '').trim().toLowerCase().replace(/-/g, ' ');
  return (ALIAS[x] ?? x).replace(/ /g, '_');
}
const FORMAT_OF: Record<string, string> = {
  coffee_shop: 'coffee', cafe: 'cafe', tea_house: 'tea', bubble_tea_shop: 'tea', bakery: 'bakery', pastry_shop: 'bakery',
  ice_cream_shop: 'dessert', dessert_shop: 'dessert', bar: 'bar', wine_bar: 'bar', cocktail_bar: 'bar', pub: 'bar', brewery: 'bar',
  restaurant: 'restaurant',
};

export function starterProfile(handle: string, s: Omit<TasteSaveInput, 'type'>) {
  const cuisines = new Map<string, number>();
  const formats = new Map<string, number>();
  const dishes = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, w: number) => k && m.set(k, (m.get(k) ?? 0) + w);
  let n = 0;
  for (const p of s.places) {
    n += 2;
    const cats = p.candidate.categories ?? [];
    const fromGoogle = cats.filter((t) => t.endsWith('_restaurant')).map((t) => t.slice(0, -'_restaurant'.length)).filter((t) => !NOT_CUISINE.has(t));
    const labels = new Set([...fromGoogle.map(normCuisine), ...(p.cuisine ? [normCuisine(p.cuisine)] : [])]);
    for (const c of labels) add(cuisines, c, 2);
    const f = cats.map((t) => FORMAT_OF[t]).find(Boolean);
    if (f) add(formats, f, 2);
  }
  for (const c of s.cuisines ?? []) {
    add(cuisines, normCuisine(c), 5);
    n += 5;
  }
  for (const d of s.dishes ?? []) add(dishes, d.toLowerCase(), 3);
  const N = n || 1;
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    version: 3,
    starter: true, // from onboarding; profile.py replaces it
    user_id: handle,
    n_food_places: n,
    n_with_notes: 0,
    regions: {},
    formats: Object.fromEntries(sorted(formats).map(([k, v]) => [k, { count: v, share: Math.round((v / N) * 1000) / 1000 }])),
    cuisines: Object.fromEntries(sorted(cuisines).map(([k, v]) => [k, { count: v, share: Math.round((v / N) * 1000) / 1000 }])),
    dishes: Object.fromEntries(sorted(dishes)),
    sources: [],
    source_types: {},
    sentiments: {},
    negative_or_near_miss: [],
    avoid: [],
    dislikes: { cuisines: [], dishes: [], formats: [], other: s.dislikes ?? [] },
    stated_cuisines: [...new Set((s.cuisines ?? []).map(normCuisine))].sort(),
    n_stated: (s.cuisines?.length ?? 0) + (s.dishes?.length ?? 0) + (s.dislikes?.length ?? 0),
  };
}

// a short handle for the scripts, from the email ("dana.lee@x.com" -> "dana-lee"), made unique
export async function makeHandle(email: string, taken: (h: string) => Promise<boolean>): Promise<string> {
  const base = (email.split('@')[0] ?? 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'user';
  for (let i = 1; i < 50; i++) {
    const h = i === 1 ? base : `${base}-${i}`;
    if (!(await taken(h))) return h;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export function placeRow(uid: string, p: TasteSaveInput['places'][number]) {
  const c = p.candidate;
  return {
    user_id: uid,
    place_key: `onboard:${c.google_place_id}`,
    list_name: 'favorites',
    added_via: 'onboard',
    list_set_in_app: true,
    title: p.name,
    google_place_id: c.google_place_id,
    google_name: c.name,
    address: c.address,
    location: c.lat !== null && c.lng !== null ? `SRID=4326;POINT(${c.lng} ${c.lat})` : null,
    categories: c.categories,
    is_food: c.is_food,
    match_confidence: 'good',
    source_type: 'onboard',
  };
}

export function prefRows(uid: string, s: Omit<TasteSaveInput, 'type'>) {
  const raw = (s.text ?? '').slice(0, 2000) || null;
  const rows = [
    ...(s.cuisines ?? []).map((v) => ({ kind: 'cuisine', value: v.toLowerCase() })),
    ...(s.dishes ?? []).map((v) => ({ kind: 'dish', value: v.toLowerCase() })),
    ...(s.dislikes ?? []).map((v) => ({ kind: 'dislike_other', value: v })),
  ];
  const seen = new Set<string>();
  return rows.filter((r) => r.value && !seen.has(`${r.kind}|${r.value}`) && seen.add(`${r.kind}|${r.value}`)).map((r) => ({ user_id: uid, ...r, raw }));
}

// ---------- a screenshot of a list from another app ----------

export const SHOT_PROMPT = `This is a screenshot of a list of restaurants, cafes, bars or food shops, probably from
another app (Beli, Yelp, Google Maps, Instagram, a notes app). List every place on it, in order.
Answer with JSON only:
{"app": "the app it seems to come from, or null",
 "places": [{"name": "place name as shown", "location_hint": "neighborhood or city if shown, else empty",
             "note": "the user's own rating, score or note if shown, else empty"}]}
At most ${MAX_SHOT_PLACES} places. Leave out ads, section headings and the app's own suggestions.`;

export function parseShot(text: string): { app: string | null; places: Omit<ShotPlace, 'candidates'>[] } {
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const d = JSON.parse(raw);
    const places = (Array.isArray(d.places) ? d.places : [])
      .filter((p: { name?: unknown }) => typeof p?.name === 'string' && p.name.trim())
      .slice(0, MAX_SHOT_PLACES)
      .map((p: { name: string; location_hint?: unknown; note?: unknown }) => ({
        name: p.name.trim(),
        location_hint: typeof p.location_hint === 'string' ? p.location_hint.trim() : '',
        note: typeof p.note === 'string' ? p.note.trim() : '',
      }));
    return { app: typeof d.app === 'string' && d.app.trim() ? d.app.trim() : null, places };
  } catch {
    return { app: null, places: [] };
  }
}

export async function screenshotList(input: ShotInput, deps: OnboardDeps): Promise<ShotResult> {
  if (!input.image_base64) return { app: null, places: [], message: 'No screenshot received.' };
  const parsed = parseShot(await deps.claude([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image_base64 } },
    { type: 'text', text: SHOT_PROMPT },
  ], true));
  const bias = typeof input.lat === 'number' && typeof input.lng === 'number' ? { lat: input.lat, lng: input.lng } : undefined;
  const places = await Promise.all(parsed.places.map(async (p) => ({ ...p, candidates: await candidatesFor(p.name, p.location_hint, bias, deps) })));
  return { app: parsed.app, places, message: places.length ? undefined : "Couldn't find a list of places in that screenshot." };
}
