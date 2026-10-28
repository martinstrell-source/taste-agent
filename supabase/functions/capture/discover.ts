// "Discover here": find places in the area on screen that fit this user's taste.
// Two modes, called separately by the app so quick results show while the slow ones run:
//   google  seconds: Google search for the user's top cuisines in the area, well-rated or new places
//   web     a minute: Claude searches the web (local food press, "best new" lists) for the area
// Results go into the shared pool of picks (candidates), so they show in Nearby, and each one gets a
// score and reason for this user (pick_scores). Areas are cached for 30 days, shared by all users.
// Pure logic with injected calls so it can be tested; index.ts wires it up.

export type DiscoverInput = { type: 'discover'; mode: 'google' | 'web'; lat: number; lng: number; radius_m?: number; area_name?: string };

export type Place = Record<string, unknown>;
export type CandidateRow = {
  item_id: string;
  source: string;
  item_title: string;
  item_link: string | null;
  name: string;
  location_hint: string;
  mention_type: string;
  cuisine: string | null;
  dishes: string[];
  what_it_says: string;
  google_place_id: string;
  google_name: string;
  address: string | null;
  location: string | null; // EWKT point
  categories: string[];
  primary_type: string | null;
  business_status: string;
  maps_uri: string | null;
  match_confidence: string;
  is_food: boolean;
  in_bay_area: boolean;
  tone: string;
};
export type Score = { google_place_id: string; score: number; reason: string };

export type DiscoverDeps = {
  topCuisines: () => Promise<string[]>; // this user's, strongest first
  knownIds: () => Promise<Set<string>>; // saved or reacted to: never suggested
  cachedQueries: (areaKey: string, days: number) => Promise<Set<string>>; // item_ids searched recently
  webRunsToday: () => Promise<number>;
  googleSearch: (query: string, box: Box, rating: boolean) => Promise<Place[]>;
  claudeWeb: (prompt: string) => Promise<{ text: string; searches: number }>;
  save: (items: { item_id: string; source: string; title: string; link: string | null }[], rows: CandidateRow[], scores: Score[], areaKey: string, mode: string) => Promise<void>;
  existingForArea: (areaKey: string, prefix: string) => Promise<{ google_place_id: string; cuisine: string | null; source: string }[]>;
};

export type Box = { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };

export const CACHE_DAYS = 30;
export const WEB_PER_DAY = 3;
const TOO_BROAD = new Set(['american', 'asian', 'european', 'fusion', 'cafe', 'restaurant', 'breakfast', 'brunch']);
const FOOD = /restaurant|food|cafe|coffee|bakery|bar|pub|brewery|winery|meal_|ice_cream|dessert|tea|juice|deli|confectionery|donut|bagel/;

// about 5 km cells: everyone near the same spot shares one cache entry
export function areaKey(lat: number, lng: number): string {
  return `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lng * 20) / 20).toFixed(2)}`;
}

export function boxAround(lat: number, lng: number, radiusM: number): Box {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { low: { latitude: lat - dLat, longitude: lng - dLng }, high: { latitude: lat + dLat, longitude: lng + dLng } };
}

function cityOf(address: string | null | undefined): string {
  const parts = (address ?? '').split(',').map((x) => x.trim());
  return parts.length >= 3 ? parts[parts.length - 3] : parts[0] ?? '';
}

function nice(c: string): string {
  return c.replace(/_/g, ' ').replace(/\//g, ' or ');
}

export function toRow(g: Place, itemId: string, source: string, title: string, link: string | null, extra: Partial<CandidateRow>): CandidateRow | null {
  const id = g.id as string | undefined;
  if (!id) return null;
  const loc = (g.location ?? {}) as { latitude?: number; longitude?: number };
  const types = (g.types as string[] | undefined) ?? [];
  const name = ((g.displayName as { text?: string } | undefined)?.text ?? '').trim();
  return {
    item_id: itemId,
    source,
    item_title: title,
    item_link: link,
    name,
    location_hint: cityOf(g.formattedAddress as string),
    mention_type: 'discovery',
    cuisine: null,
    dishes: [],
    what_it_says: '',
    google_place_id: id,
    google_name: name,
    address: (g.formattedAddress as string) ?? null,
    location: loc.latitude != null && loc.longitude != null ? `SRID=4326;POINT(${loc.longitude} ${loc.latitude})` : null,
    categories: types,
    primary_type: (g.primaryType as string) ?? null,
    business_status: (g.businessStatus as string) ?? 'OPERATIONAL',
    maps_uri: (g.googleMapsUri as string) ?? null,
    match_confidence: 'good',
    is_food: types.some((t) => FOOD.test(t)),
    in_bay_area: false, // Discover here results stay out of the weekly Bay Area picks; Nearby shows them by distance
    tone: 'neutral',
    ...extra,
  };
}

function quality(rating: number | undefined, count: number | undefined): number {
  if (!rating) return 0.5;
  const k = 30;
  const c = count ?? 0;
  return ((rating * c + 4.2 * k) / (c + k) - 3.8) / 1.2; // about 0 to 1
}

// ---------- quick: Google ----------

export async function discoverGoogle(input: DiscoverInput, deps: DiscoverDeps) {
  const key = areaKey(input.lat, input.lng);
  const box = boxAround(input.lat, input.lng, Math.min(Math.max(input.radius_m ?? 6000, 2000), 15000));
  const cuisines = (await deps.topCuisines()).filter((c) => !TOO_BROAD.has(c)).slice(0, 5);
  const queries = [...cuisines.map((c) => ({ c, q: `${nice(c)} restaurant` })), { c: '', q: 'best restaurants' }];
  const known = await deps.knownIds();
  const cached = await deps.cachedQueries(key, CACHE_DAYS);

  const items: { item_id: string; source: string; title: string; link: string | null }[] = [];
  const rows: CandidateRow[] = [];
  const scores = new Map<string, Score>();
  let searched = 0;

  await Promise.all(
    queries.map(async ({ c, q }, qi) => {
      const itemId = `here:${key}:g:${c || 'best'}`;
      let places: Place[] = [];
      if (cached.has(itemId)) {
        // searched recently for this area: reuse what's in the pool
        const prev = await deps.existingForArea(key, itemId);
        places = prev.map((p) => ({ id: p.google_place_id, _cached: true }));
      } else {
        places = await deps.googleSearch(q, box, true).catch(() => []);
        searched += 1;
        items.push({ item_id: itemId, source: 'Google Maps search', title: c ? `${nice(c)} places near ${input.area_name ?? 'here'}` : `Well-rated places near ${input.area_name ?? 'here'}`, link: null });
      }
      places.forEach((g, rank) => {
        const id = g.id as string;
        if (!id || known.has(id)) return;
        if (!g._cached) {
          const types = (g.types as string[] | undefined) ?? [];
          const count = (g.userRatingCount as number | undefined) ?? 0;
          if ((g.businessStatus ?? 'OPERATIONAL') !== 'OPERATIONAL' || !types.some((t) => FOOD.test(t))) return;
          if (count >= 20 && ((g.rating as number | undefined) ?? 0) < 4.3) return;
          const row = toRow(g, itemId, 'Google Maps search', c ? `${nice(c)} near ${input.area_name ?? 'here'}` : 'Well rated nearby', null, {
            cuisine: c || null,
            what_it_says: count < 20 ? `New: ${count} reviews on Google.` : `${(g.rating as number).toFixed(1)} stars from ${count} reviews on Google.`,
          });
          if (row) rows.push(row);
        }
        // fit: earlier cuisines and higher in the results score higher; quality from Google rating
        const fit = c ? (1 - qi / (queries.length + 1)) * (1 - rank / 25) : 0.35 * (1 - rank / 25);
        const score = 0.6 * fit + 0.4 * quality(g.rating as number, g.userRatingCount as number);
        const reason = c ? `${nice(c)[0].toUpperCase()}${nice(c).slice(1)}, one of your top cuisines` : 'Well rated nearby';
        const prev = scores.get(id);
        if (!prev || score > prev.score) scores.set(id, { google_place_id: id, score: Math.round(score * 1000) / 1000, reason });
      });
    }),
  );

  await deps.save(items, rows, [...scores.values()], key, 'google');
  return { mode: 'google', area: key, searched, places: scores.size };
}

// ---------- slow: the web ----------

export function webPrompt(area: string, cuisines: string[]): string {
  return `Find restaurants, cafes, bakeries and bars in or near ${area} that a visitor with this taste would want to try.
Their favorite cuisines: ${cuisines.map(nice).join(', ') || 'varied'}.
Use the local food press, "best new restaurants" lists, local guides and recent reviews. Prefer places that opened or
got press in the last year, and lesser-known places that fit their cuisines, over famous tourist standbys.
Places must be open now.

Return up to 15 places. End your answer with a JSON array in a \`\`\`json block, one object per place:
{"name": "...", "city": "...", "cuisine": "...", "dishes": ["..."],
 "why": "one sentence in your own words on why it fits this person (no quotes from articles)",
 "source": "publication name", "source_title": "article title", "source_url": "..."}`;
}

export function parseWeb(text: string): { name: string; city: string; cuisine: string; dishes: string[]; why: string; source: string; source_title: string; source_url: string }[] {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  try {
    const d = JSON.parse(blocks.length ? blocks[blocks.length - 1][1] : text);
    return (Array.isArray(d) ? d : [])
      .filter((p) => typeof p?.name === 'string' && p.name.trim())
      .slice(0, 15)
      .map((p) => ({
        name: String(p.name).trim(),
        city: String(p.city ?? '').trim(),
        cuisine: String(p.cuisine ?? '').trim().toLowerCase(),
        dishes: Array.isArray(p.dishes) ? p.dishes.filter((x: unknown) => typeof x === 'string').slice(0, 6) : [],
        why: String(p.why ?? '').trim().slice(0, 300),
        source: String(p.source ?? 'Web').trim(),
        source_title: String(p.source_title ?? '').trim(),
        source_url: String(p.source_url ?? '').trim(),
      }));
  } catch {
    return [];
  }
}

function similar(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(the|restaurant|cafe|bar)\b/g, '').trim();
  const x = n(a), y = n(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

export async function discoverWeb(input: DiscoverInput, deps: DiscoverDeps) {
  const key = areaKey(input.lat, input.lng);
  const box = boxAround(input.lat, input.lng, Math.min(Math.max(input.radius_m ?? 6000, 3000), 20000));
  const cached = await deps.cachedQueries(key, CACHE_DAYS);
  const known = await deps.knownIds();
  const cuisines = (await deps.topCuisines()).filter((c) => !TOO_BROAD.has(c)).slice(0, 6);

  if ([...cached].some((id) => id.startsWith(`here:${key}:w:`))) {
    // the web was searched for this area recently (by anyone): reuse, and score for this user
    const prev = await deps.existingForArea(key, `here:${key}:w:`);
    const scores = prev
      .filter((p) => !known.has(p.google_place_id))
      .map((p) => ({ google_place_id: p.google_place_id, score: 0.55, reason: `From ${p.source}` }));
    await deps.save([], [], scores, key, 'web-cached');
    return { mode: 'web', area: key, cached: true, places: scores.length };
  }
  if ((await deps.webRunsToday()) >= WEB_PER_DAY) {
    return { mode: 'web', area: key, places: 0, message: `Web search is limited to ${WEB_PER_DAY} new areas a day. The quick results are still here.` };
  }

  const { text, searches } = await deps.claudeWeb(webPrompt(input.area_name || `the area around ${input.lat.toFixed(3)}, ${input.lng.toFixed(3)}`, cuisines));
  const found = parseWeb(text);
  const items: { item_id: string; source: string; title: string; link: string | null }[] = [];
  const rows: CandidateRow[] = [];
  const scores: Score[] = [];
  await Promise.all(
    found.map(async (f, i) => {
      if (!/^https?:\/\//.test(f.source_url)) return;
      const res = await deps.googleSearch(`${f.name} ${f.city}`, box, false).catch(() => []);
      const g = res.find((r) => similar(f.name, ((r.displayName as { text?: string } | undefined)?.text ?? '')));
      if (!g || (g.businessStatus ?? 'OPERATIONAL') !== 'OPERATIONAL') return;
      const itemId = `here:${key}:w:${f.source_url}`.slice(0, 500);
      if (!items.some((x) => x.item_id === itemId)) items.push({ item_id: itemId, source: f.source, title: f.source_title || f.source, link: f.source_url });
      const row = toRow(g, itemId, f.source, f.source_title || f.source, f.source_url, {
        mention_type: 'list_entry', cuisine: f.cuisine || null, dishes: f.dishes, what_it_says: f.why, tone: 'positive',
      });
      if (!row || known.has(row.google_place_id)) return;
      rows.push(row);
      const liked = cuisines.some((c) => f.cuisine.includes(nice(c)) || nice(c).includes(f.cuisine));
      scores.push({ google_place_id: row.google_place_id, score: Math.round((0.75 - i * 0.01 + (liked ? 0.1 : 0)) * 1000) / 1000, reason: liked ? `${f.cuisine[0]?.toUpperCase()}${f.cuisine.slice(1)}, a favorite of yours; from ${f.source}` : `From ${f.source}` });
    }),
  );
  if (!items.length) items.push({ item_id: `here:${key}:w:none`, source: 'Web', title: 'No web results', link: null });
  await deps.save(items, rows, scores, key, 'web');
  return { mode: 'web', area: key, searches, places: scores.length };
}
