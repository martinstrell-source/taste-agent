// "Discover here": find places in the area on screen that fit this user's taste.
// Two modes, called separately by the app so quick results show while the slow ones run:
//   google  seconds: Google search for the user's top cuisines in the area, well-rated or new places
//   web     a minute: Claude searches the web (local food press, "best new" lists) for the area
// Results go into the shared pool of picks (candidates), so they show in Nearby, and each one gets a
// score and reason for this user (pick_scores). Areas are cached for 30 days, shared by all users.
// Away from home (over AWAY_KM from where most of the user's saves are), it favors what the place is
// known for: local specialties first, the user's cuisines when they are also a local strength, things the
// city does especially well (pizza and coffee in Tokyo), and other cuisines only when the place is a standout.
// What each city is known for is asked once and shared by all users (area_profiles).
// Each run fills a trace (what was searched, what came back, what was dropped and why); index.ts saves it
// in discover_runs.
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
// filled in as a run goes; saved by index.ts whether the run succeeds or fails
export type Trace = Record<string, unknown>;
export type WebResult = { text: string; searches: number; queries?: string[]; pages?: { url: string; title: string }[] };
export type Specialty = { name: string; query: string; tags: string[] };
export type Institution = { name: string; why: string };
// size: major | mid | small; institutions: the places the city is known for (asked since Oct 30; older profiles are asked again once)
export type AreaProfile = { size?: string; local: Specialty[]; strengths: Specialty[]; institutions?: Institution[]; area?: string; city?: string };

export type DiscoverDeps = {
  topCuisines: () => Promise<string[]>; // this user's, strongest first
  knownIds: () => Promise<Set<string>>; // saved or reacted to: never suggested
  cachedQueries: (areaKey: string, days: number) => Promise<Set<string>>; // item_ids searched recently
  webRunsToday: () => Promise<number>;
  webLimit?: () => Promise<number | null>; // this user's own daily web limit, if set (else WEB_PER_DAY)
  googleSearch: (query: string, box: Box, rating: boolean) => Promise<Place[]>;
  claudeWeb: (prompt: string) => Promise<WebResult>;
  save: (items: { item_id: string; source: string; title: string; link: string | null }[], rows: CandidateRow[], scores: Score[], areaKey: string, mode: string) => Promise<void>;
  existingForArea: (areaKey: string, prefix: string) => Promise<{ google_place_id: string; name?: string | null; cuisine: string | null; source: string }[]>;
  home: () => Promise<{ lat: number; lng: number } | null>; // center of most of the user's saves
  getAreaProfile: (cityKey: string) => Promise<AreaProfile | null>;
  saveAreaProfile: (cityKey: string, areaName: string, p: AreaProfile) => Promise<void>;
  claudeText: (prompt: string) => Promise<string>; // no web search: fast
  dislikes?: () => Promise<string[]>; // what this user said no to, in their words ("Golden Dragon: looks American Chinese")
  vibes?: () => Promise<string[]>; // kinds of places they like ("hole in the wall", "rooftop"), from "Your taste"
  taste?: () => Promise<string>; // a few lines on the user's taste for the rerank (cuisines, dishes, places they love)
};

export type Box = { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };

export const CACHE_DAYS = 30;
export const WEB_PER_DAY = 3;
export const AWAY_KM = 100;
const TOO_BROAD = new Set(['american', 'asian', 'european', 'fusion', 'cafe', 'restaurant', 'breakfast', 'brunch']);
// global chains: never a discovery, home or away
const CHAINS = /^(round table|mountain mike'?s|peet'?s|in-n-out|jack in the box|carl'?s jr|del taco|el pollo loco|panera|olive garden|applebee'?s|chili'?s|denny'?s|ihop|red robin|the cheesecake factory|cheesecake factory|p\.? ?f\.? chang'?s|buffalo wild wings|wingstop|jersey mike'?s|jimmy john'?s|firehouse subs|noodles & company|pieology|mod pizza|blaze pizza|the habit burger|togo'?s|jamba|black bear diner|marie callender'?s|raising cane'?s|whataburger|sonic drive-in|arby'?s|qdoba|texas roadhouse|red lobster|cracker barrel|cold stone|yogurtland|pinkberry|auntie anne'?s|cinnabon|jollibee|dutch bros|the coffee bean|coffee bean & tea leaf|tropical smoothie|smoothie king|sweetgreen|cava|pizza hut|kfc|mcdonald'?s|starbucks|domino'?s|subway|burger king|papa john'?s|dunkin'?|taco bell|wendy'?s|tim hortons|costa coffee|dairy queen|hard rock cafe|five guys|shake shack|popeyes|chick-fil-a|little caesars|panda express|chipotle|sizzler|tgi friday'?s|outback steakhouse|haagen-dazs|baskin-robbins|krispy kreme|7-eleven|family ?mart|lawson|luckin coffee|mixue|yoshinoya|sukiya|matsuya|coco ichibanya|saizeriya)\b/i;
// food businesses that aren't somewhere to go eat or drink: a caterer, a butcher, a delivery kitchen, a grocery,
// a gas station that sells coffee (by Google's main type: a taqueria inside a gas station is still a restaurant)
const NOT_A_PLACE = /^(catering_service|caterer|food_delivery|meal_delivery|butcher_shop|grocery_store|supermarket|convenience_store|wholesaler|food_store|asian_grocery_store|warehouse_store|gas_station|truck_stop|rest_stop|department_store|discount_store)$/;
export function notAPlaceToEat(g: { primaryType?: unknown; types?: unknown }): string | null {
  const t = (g.primaryType as string | undefined) ?? ((g.types as string[] | undefined) ?? [])[0];
  return t && NOT_A_PLACE.test(t) ? t.replace(/_/g, ' ') : null;
}

const reviews = (n: number) => `${n} review${n === 1 ? '' : 's'}`;

export function isChain(name: string): boolean {
  return CHAINS.test(name.trim().replace(/[’`]/g, "'"));
}
const FOOD = /restaurant|food|cafe|coffee|bakery|bar|pub|brewery|winery|meal_|ice_cream|dessert|tea|juice|deli|confectionery|donut|bagel/;

// ---------- what the user said no to ----------

// ---------- the rerank: one Claude call reads the user's taste and every place Discover found ----------
// It scores each place for this person with a specific reason, flags chains (regional ones the name list
// misses, like Round Table) and, when the user has said why they turned places down, places like those.
// It runs in batches; a batch that fails keeps Discover's own reasons, on the same scale.

export type RerankItem = { id: string; name: string; detail: string; score: number; reason: string };

export function rerankPrompt(taste: string, dislikes: string[], places: RerankItem[]): string {
  const noes = dislikes.length ? `\nWhen they turned suggestions down, they said:\n${dislikes.map((d) => `- ${d}`).join('\n')}\n` : '';
  return `An app suggests restaurants, cafes and bars to one person. What it knows about their taste:
${taste || '(not much yet)'}
${noes}
Places found near where they are looking (name, then what Google or an article says about it):
${places.map((p, i) => `${i + 1}. ${p.name}${p.detail ? ` (${p.detail})` : ''}`).join('\n')}

For every place:
- "fit": 0-100, how likely this person is to want to try it, from their taste (not just popularity).
- "why": one short reason, written to them as "you", specific where you can ("Hand-pulled noodles, like Xi'an
  Famous you saved"). Never "they" or "the user". Plain words, under 12 words, no flattery. Don't claim they've
  been anywhere. Say what makes it worth trying; never say what it isn't ("not your usual cuisines"). If it's a
  poor fit, give it a low fit and a short plain description.
- "chain": true for a business with many locations under the same name across a region or the country
  (Round Table Pizza, Peet's Coffee, Panera). A local business with a few locations in one city is not a chain.${dislikes.length ? `
- "no": true only when the name or details make it clear they'd turn it down for the reasons they gave
  (a reason like "too far" or "too pricey" for one place says little about others).` : ''}
Answer with only a JSON array, one object per place: [{"n": 1, "fit": 72, "why": "...", "chain": false${dislikes.length ? ', "no": false' : ''}}]`;
}

// reasons are written to the user: if Claude still says "they", turn it into "you"
export function toYou(s: string): string {
  return s
    .replace(/\bthey're\b/gi, "you're").replace(/\bthey've\b/gi, "you've").replace(/\bthey'd\b/gi, "you'd")
    .replace(/\bthemselves\b/gi, 'yourself').replace(/\btheir\b/gi, 'your').replace(/\bthem\b/gi, 'you')
    .replace(/\bthey\b/gi, 'you')
    .replace(/^you/, 'You').replace(/^your/, 'Your');
}

export const RERANK_BATCH = 25; // places per Claude call: a long list in one call can come back cut off
const MAX_RERANK = 150;

type Verdict = { n?: unknown; fit?: unknown; why?: unknown; chain?: unknown; no?: unknown };

async function rerankBatch(list: RerankItem[], taste: string, dislikes: string[], deps: DiscoverDeps): Promise<Map<number, Verdict> | null> {
  const answer = await deps.claudeText(rerankPrompt(taste, dislikes, list)).catch(() => '');
  try {
    const m = answer.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(m ? m[0] : 'null');
    if (!Array.isArray(parsed)) return null;
    return new Map((parsed as Verdict[]).map((x) => [Number(x?.n), x]));
  } catch {
    return null;
  }
}

export async function rerank(items: RerankItem[], deps: DiscoverDeps, trace: Trace): Promise<Score[]> {
  if (!items.length) return [];
  const list = items.slice(0, MAX_RERANK);
  const [taste, dislikes] = await Promise.all([
    deps.taste?.().catch(() => '') ?? Promise.resolve(''),
    deps.dislikes?.().catch(() => [] as string[]) ?? Promise.resolve([] as string[]),
  ]);
  // in batches, all at once: every place gets read, and one bad answer only affects its own batch
  const batches: RerankItem[][] = [];
  for (let i = 0; i < list.length; i += RERANK_BATCH) batches.push(list.slice(i, i + RERANK_BATCH));
  const verdicts = await Promise.all(batches.map((b) => rerankBatch(b, taste, dislikes, deps)));
  const failed = verdicts.filter((v) => v === null).length;

  const chains: string[] = [];
  const noes: { name: string; why: string }[] = [];
  const tr: { name: string; fit: number | null; why: string; score: number }[] = [];
  const out: Score[] = [];
  // a place with no verdict (its batch failed) gets a middling fit, so it ranks on the same scale as the rest
  const blend = (score: number, fit: number) => Math.round((0.3 * score + 0.7 * (fit / 100)) * 1000) / 1000;
  batches.forEach((batch, b) => {
    const byN = verdicts[b];
    batch.forEach((p, i) => {
      const x = byN?.get(i + 1);
      if (x?.chain === true) return void chains.push(p.name);
      if (dislikes.length && x?.no === true) return void noes.push({ name: p.name, why: String(x?.why ?? '') });
      const fit = typeof x?.fit === 'number' ? Math.max(0, Math.min(100, x.fit)) : null;
      const why = toYou(String(x?.why ?? '').trim().slice(0, 140));
      // Discover's own score still counts (local specialties, quality); the fit for this person counts more.
      // A city's institutions keep their label ("A Boston institution: ...").
      const score = blend(p.score, fit ?? 50);
      const reason = /institution/i.test(p.reason) || !why ? p.reason : why;
      out.push({ google_place_id: p.id, score, reason });
      tr.push({ name: p.name, fit, why, score });
    });
  });
  out.push(...items.slice(MAX_RERANK).map((x) => ({ google_place_id: x.id, score: blend(x.score, 50), reason: x.reason })));
  trace.chains_left_out = chains;
  if (dislikes.length) trace.your_noes = { said: dislikes, left_out: noes };
  trace.rerank_batches = { batches: batches.length, failed };
  trace.rerank = failed === batches.length ? "could not read the answers; kept Discover's own ranking" : tr.sort((a, b) => b.score - a.score);
  return out;
}

// ---------- which of the user's cuisines say the most about them ----------

// fallback base rates (as in match.py), used until the shared pool is big enough to measure them
export const BASE_CUISINE: Record<string, number> = {
  american: 0.15, chinese: 0.10, mexican: 0.10, italian: 0.07, japanese: 0.07, pizza: 0.06, burgers: 0.04,
  thai: 0.04, indian: 0.04, vietnamese: 0.04, korean: 0.03, mediterranean: 0.03, seafood: 0.03, french: 0.02,
  bbq: 0.02, middle_eastern: 0.02, californian: 0.03, 'uyghur/central_asian': 0.002,
};
export const MIN_POOL = 300; // places in the pool before its base rates are trusted

// as match.py's lift_score: half how much more often than a typical diner (full at 8x), half plain volume
export function liftScore(share: number, base: number, maxShare: number, cap = 8): number {
  if (share <= 0) return 0;
  const lift = share / base;
  const distinct = lift > 1 ? Math.max(0, Math.min(1, Math.log(lift) / Math.log(cap))) : 0;
  return 0.5 * distinct + 0.5 * Math.min(1, share / maxShare);
}

// the profile as the user has edited it ("Your taste" in the app): cuisines and dishes they hid come out,
// ones they added count now (the weekly rebuild on the mini folds them in properly)
export type Pref = { kind: string; value: string };
// "burritos" and "burrito" are one dish: compare on the singular of the last word (same as the app)
export function dishKey(d: string): string {
  const w = d.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}
const normC = (c: string) => c.trim().toLowerCase().replace(/-/g, ' ').replace(/ /g, '_');
export function editedTaste(prof: { cuisines?: Record<string, { share?: number }>; dishes?: Record<string, number> } | null, prefs: Pref[]) {
  const hideC = new Set(prefs.filter((p) => p.kind === 'not_cuisine').map((p) => normC(p.value)));
  const hideD = new Set(prefs.filter((p) => p.kind === 'not_dish').map((p) => dishKey(p.value)));
  const cuisines: Record<string, { share: number }> = {};
  for (const [c, v] of Object.entries(prof?.cuisines ?? {})) if (!hideC.has(c)) cuisines[c] = { share: v?.share ?? 0 };
  const top = Math.max(0.05, ...Object.values(cuisines).map((v) => v.share));
  for (const p of prefs) {
    const c = normC(p.value);
    if (p.kind === 'cuisine' && c && !hideC.has(c) && !(c in cuisines)) cuisines[c] = { share: top / 2 };
  }
  // dishes the user added first: the rerank sees only the first 10
  const seen = new Set<string>();
  const dishes = [...prefs.filter((p) => p.kind === 'dish').map((p) => p.value.trim().toLowerCase()), ...Object.keys(prof?.dishes ?? {})]
    .filter((d) => {
      const k = dishKey(d);
      if (!d || hideD.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const avoid = prefs.filter((p) => p.kind.startsWith('dislike_')).map((p) => p.value);
  const vibes = prefs.filter((p) => p.kind === 'vibe').map((p) => p.value);
  return { cuisines, dishes, avoid, vibes };
}

// the user's cuisines, most telling first: saving a lot of Mexican in the Bay Area says less than saving Burmese
export function rankCuisines(
  profile: Record<string, { share?: number; count?: number }>,
  measured: { cuisine: string; share: number }[],
  poolSize: number,
): { cuisine: string; score: number; share: number; base: number }[] {
  const base: Record<string, number> = { ...BASE_CUISINE };
  if (poolSize >= MIN_POOL) for (const m of measured) base[m.cuisine] = m.share;
  const entries = Object.entries(profile).map(([c, v]) => [c, v?.share ?? 0] as const);
  const max = Math.max(0, ...entries.map(([, s]) => s)) || 1;
  return entries
    .map(([c, s], i) => {
      const b = Math.max(0.002, base[c] ?? 0.01);
      return { cuisine: c, share: s, base: b, score: liftScore(s, b, max), i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ i: _i, ...r }) => r);
}

// about 5 km cells: everyone near the same spot shares one cache entry
export function areaKey(lat: number, lng: number): string {
  return `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lng * 20) / 20).toFixed(2)}`;
}

export function boxAround(lat: number, lng: number, radiusM: number): Box {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { low: { latitude: lat - dLat, longitude: lng - dLng }, high: { latitude: lat + dLat, longitude: lng + dLng } };
}

// about 50 km cells: one "what is this place known for" answer per city
export function cityKey(lat: number, lng: number): string {
  return `${(Math.round(lat * 2) / 2).toFixed(1)},${(Math.round(lng * 2) / 2).toFixed(1)}`;
}

export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function areaPrompt(area: string): string {
  return `Someone who travels for food is visiting ${area}.
1. List up to 6 things this place is known for that are hard to find elsewhere: local cuisines, dishes, styles,
   regional food that is strong here (for Beijing: Peking roast duck, zhajiangmian, Hui Muslim food, Xinjiang food).
2. List up to 3 non-local categories this place does better than almost anywhere (for Tokyo: pizza, specialty coffee).
   Leave it empty if nothing stands out. Do not list a category just because it is popular.
3. Size: "major" for a big city with a deep food scene (Beijing, Tokyo, New York), "mid" for a regional city,
   "small" for a town or small city.
4. "city": the plain name of the city or town people would use (for a neighborhood like the Lower East Side,
   "New York"; for "Rapid City, SD", "Rapid City").
5. Up to 8 institutions: restaurants, bakeries, cafes or bars this place is famous for that locals and local food
   writers still consider essential (for New York: Katz's Delicatessen, Russ & Daughters). Skip tourist traps locals
   avoid and chains. Only places you are confident are still open. For a small town, list fewer or none.
Return only JSON, no other text:
{"city": "Beijing", "size": "major", "local": [{"name": "Peking roast duck", "query": "peking roast duck restaurant", "tags": ["peking duck", "roast duck", "beijing", "chinese"]}],
 "strengths": [{"name": "...", "query": "...", "tags": ["..."]}],
 "institutions": [{"name": "Siji Minfu", "why": "a few words on what it is known for"}]}
"query" is a short Google Maps search in English. "tags" are lowercase cuisine words a food app might use for these
places (include the broad cuisine, like "chinese", and regional ones, like "uyghur" or "central asian").
A tag must never name a different cuisine: Native American "Indian tacos" get "native american" and "frybread", not "indian".`;
}

export function parseAreaProfile(text: string): AreaProfile | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[0]);
    const list = (x: unknown, n: number): Specialty[] =>
      (Array.isArray(x) ? x : [])
        .filter((p) => typeof p?.name === 'string' && typeof p?.query === 'string' && p.name.trim() && p.query.trim())
        .slice(0, n)
        .map((p) => ({
          name: String(p.name).trim(),
          query: String(p.query).trim(),
          tags: (Array.isArray(p.tags) ? p.tags : []).filter((t: unknown) => typeof t === 'string').map((t: string) => t.toLowerCase().trim()).filter(Boolean),
        }));
    const size = ['major', 'mid', 'small'].includes(d.size) ? d.size : undefined;
    const institutions = (Array.isArray(d.institutions) ? d.institutions : [])
      .filter((x: { name?: unknown }) => typeof x?.name === 'string' && x.name.trim())
      .slice(0, 8)
      .map((x: { name: string; why?: unknown }) => ({ name: x.name.trim(), why: String(x.why ?? '').trim().slice(0, 160) }));
    const city = typeof d.city === 'string' && d.city.trim() ? d.city.trim().slice(0, 60) : undefined;
    const p = { size, local: list(d.local, 6), strengths: list(d.strengths, 3), institutions, city };
    return p.local.length ? p : null;
  } catch {
    return null;
  }
}

// does one of the user's cuisines ("uyghur/central_asian") match a specialty's tags?
// whole labels only: "indian" must not match "indian tacos"
export function matches(cuisine: string, sp: Specialty): boolean {
  const words = cuisine.toLowerCase().replace(/_/g, ' ').split('/').map((w) => w.trim()).filter(Boolean);
  return words.some((w) => sp.tags.includes(w));
}

// away from home? and if so, what the place is known for (asked once per city, shared)
export async function awayProfile(input: DiscoverInput, deps: DiscoverDeps, trace: Trace = {}): Promise<AreaProfile | null> {
  const home = await deps.home();
  const dist = home ? Math.round(km(home, { lat: input.lat, lng: input.lng })) : null;
  trace.km_from_home = dist;
  if (dist == null || dist < AWAY_KM) {
    trace.away = false;
    return null;
  }
  trace.away = true;
  const ck = cityKey(input.lat, input.lng);
  const have = await deps.getAreaProfile(ck);
  if (have?.size && Array.isArray(have.institutions) && have.city) { // profiles saved before size, institutions or city were asked get asked again once
    trace.city_profile = { city_key: ck, from: 'saved', ...have };
    return have;
  }
  const area = input.area_name || `the area around ${input.lat.toFixed(2)}, ${input.lng.toFixed(2)}`;
  const answer = await deps.claudeText(areaPrompt(area)).catch((e) => `error: ${(e as Error).message}`);
  const p = parseAreaProfile(answer);
  if (p) p.area = p.city ?? area; // "New York", not "Lower East Side, New York"
  trace.city_profile = p ? { city_key: ck, from: 'asked Claude', ...p } : { city_key: ck, from: 'asked Claude, could not read the answer', answer: answer.slice(0, 2000) };
  if (p) await deps.saveAreaProfile(ck, area, p).catch(() => {});
  return p;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
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

// ---------- institutions: what a city is famous for ----------

// each institution from the city profile, found on Google by name; kept if open, food and well liked.
// Looked up once per area for 30 days (one feed item for all of them), then reused.
export async function findInstitutions(away: AreaProfile, input: DiscoverInput, key: string, known: Set<string>, deps: DiscoverDeps, trace: Trace) {
  const city = away.area ?? input.area_name ?? 'this city';
  const itemId = `here:${key}:g:institutions`;
  const out: { score: Score; info: { id: string; name: string; detail: string } }[] = [];
  const rows: CandidateRow[] = [];
  const t: { name: string; result: string }[] = [];
  trace.institutions = t;
  const reason = (why: string) => `A ${city} institution${why ? `: ${why}` : ''}`;
  if ((await deps.cachedQueries(key, CACHE_DAYS)).has(itemId)) {
    const prev = await deps.existingForArea(key, itemId);
    prev.forEach((p, i) => {
      if (known.has(p.google_place_id)) return void t.push({ name: p.name ?? '', result: 'already on your lists or rated' });
      t.push({ name: p.name ?? '', result: 'kept (reused from the last 30 days)' });
      const why = away.institutions?.find((x) => similar(x.name, p.name ?? ''))?.why ?? '';
      out.push({ score: { google_place_id: p.google_place_id, score: 0.95 - i * 0.02, reason: reason(why) }, info: { id: p.google_place_id, name: p.name ?? '', detail: 'local institution' } });
    });
    return { item: null, searched: 0, rows, places: out };
  }
  // wider than the search radius: a city's institutions are spread around it
  const box = boxAround(input.lat, input.lng, 15000);
  await Promise.all(
    (away.institutions ?? []).map(async (inst, i) => {
      const res = await deps.googleSearch(`${inst.name} ${city}`, box, true).catch(() => [] as Place[]);
      const g = res.find((r) => similar(inst.name, ((r.displayName as { text?: string } | undefined)?.text ?? '')));
      const drop = (why: string) => void t.push({ name: inst.name, result: why });
      if (!g?.id) return drop('not found on Google nearby');
      const types = (g.types as string[] | undefined) ?? [];
      const rating = (g.rating as number | undefined) ?? 0;
      if ((g.businessStatus ?? 'OPERATIONAL') !== 'OPERATIONAL') return drop(`not open (${g.businessStatus})`);
      if (!types.some((x) => FOOD.test(x))) return drop('not food');
      if (notAPlaceToEat(g)) return drop(`not a place to eat (${notAPlaceToEat(g)})`);
      if (rating && rating < 4.0) return drop(`rating ${rating}, under 4.0`);
      const row = toRow(g, itemId, 'Known locally', `What ${city} is known for`, null, { what_it_says: inst.why ? `${inst.why}.` : '' });
      if (row) rows.push(row);
      if (known.has(g.id as string)) return drop('already on your lists or rated');
      t.push({ name: inst.name, result: 'kept' });
      out.push({ score: { google_place_id: g.id as string, score: Math.round((0.95 - i * 0.02) * 1000) / 1000, reason: reason(inst.why) }, info: { id: g.id as string, name: inst.name, detail: inst.why } });
    }),
  );
  return { item: { item_id: itemId, source: 'Known locally', title: `What ${city} is known for`, link: null }, searched: away.institutions?.length ?? 0, rows, places: out };
}

// ---------- quick: Google ----------

export async function discoverGoogle(input: DiscoverInput, deps: DiscoverDeps, trace: Trace = {}) {
  const key = areaKey(input.lat, input.lng);
  trace.mode = 'google';
  const box = boxAround(input.lat, input.lng, Math.min(Math.max(input.radius_m ?? 6000, 2000), 15000));
  const all = (await deps.topCuisines()).filter((c) => !TOO_BROAD.has(c));
  const away = await awayProfile(input, deps, trace);
  const here = input.area_name ?? 'here';
  trace.your_cuisines = all.slice(0, 8);
  // kind sets how much a result counts (base) and the bar it has to clear (strict = standouts only)
  type Q = { c: string; q: string; label: string; cuisine: string | null; base: number; strict: boolean; local?: boolean; cap?: number; reason: string };
  let queries: Q[];
  if (!away) {
    const cuisines = all.slice(0, 5);
    queries = [
      ...cuisines.map((c, i) => ({ c, q: `${nice(c)} restaurant`, label: `${nice(c)} near ${here}`, cuisine: c, base: 1 - i / 7, strict: false, reason: `${cap(nice(c))}: one of the cuisines you save most` })),
      { c: 'best', q: 'best restaurants', label: 'Well rated nearby', cuisine: null, base: 0.35, strict: false, reason: 'Well rated near you' },
    ];
  } else {
    const specials = [...away.local, ...away.strengths];
    const yoursLocal = all.slice(0, 8).filter((c) => specials.some((sp) => matches(c, sp))).slice(0, 3);
    const other = all.slice(0, 5).find((c) => !yoursLocal.includes(c));
    queries = [
      ...away.local.slice(0, 5).map((sp, i) => ({ c: `local-${slug(sp.name)}`, q: sp.query, label: `${sp.name} in ${here}`, cuisine: sp.name.toLowerCase(), base: 1 - i / 12, strict: false, local: true, reason: `Local specialty: ${sp.name}` })),
      ...yoursLocal.map((c) => ({ c, q: `${nice(c)} restaurant`, label: `${nice(c)} near ${here}`, cuisine: c, base: 1, strict: false, reason: `${cap(nice(c))}: you save a lot of it, and ${away.area ?? input.area_name ?? 'this area'} does it especially well` })),
      ...away.strengths.slice(0, 2).map((sp) => ({ c: `strength-${slug(sp.name)}`, q: sp.query, label: `${sp.name} in ${here}`, cuisine: sp.name.toLowerCase(), base: 0.8, strict: false, reason: `${sp.name}: something ${away.area ?? input.area_name ?? 'this area'} does especially well` })),
      // a non-local standout only in a major food city; a 4.6 rating means little in a small market
      ...(other && away.size === 'major' ? [{ c: `${other}:standout`, q: `${nice(other)} restaurant`, label: `${nice(other)} near ${here}`, cuisine: other, base: 0.5, strict: true, cap: 2, reason: `${cap(nice(other))}: one of the cuisines you save most, and a standout here` }] : []),
    ];
  }
  const known = await deps.knownIds();
  const cached = await deps.cachedQueries(key, CACHE_DAYS);

  const items: { item_id: string; source: string; title: string; link: string | null }[] = [];
  const rows: CandidateRow[] = [];
  const scores = new Map<string, Score>();
  const info = new Map<string, { id: string; name: string; detail: string }>(); // for screening against the user's noes
  let searched = 0;
  const tsearches: Record<string, unknown>[] = [];
  trace.searches = tsearches;

  await Promise.all(
    queries.map(async (Q) => {
      const { c, q } = Q;
      const itemId = `here:${key}:g:${c}`;
      let places: Place[] = [];
      const kept: string[] = [];
      const dropped: { name: string; reason: string }[] = [];
      const ts: Record<string, unknown> = { query: q, why: Q.reason, bar: Q.strict ? 'standout only' : Q.local ? 'local specialty' : 'normal', kept, dropped };
      tsearches.push(ts);
      if (cached.has(itemId)) {
        // searched recently for this area: reuse what's in the pool
        const prev = await deps.existingForArea(key, itemId);
        ts.reused_from_last_30_days = true;
        for (const p of prev) if (isChain(p.name ?? '')) dropped.push({ name: p.name ?? '', reason: 'chain' });
        places = prev.filter((p) => !isChain(p.name ?? '')).map((p) => ({ id: p.google_place_id, _cached: true, _name: p.name ?? '' }));
      } else {
        places = await deps.googleSearch(q, box, true).catch((e) => ((ts.error = (e as Error).message), []));
        searched += 1;
        items.push({ item_id: itemId, source: 'Google Maps search', title: Q.label, link: null });
      }
      // a name that shows up twice in one search is a chain (fine for a local specialty: a famous duck house)
      const nameOf = (g: Place) => ((g.displayName as { text?: string } | undefined)?.text ?? '').trim().toLowerCase();
      const seen = new Map<string, number>();
      for (const g of places) if (!g._cached) seen.set(nameOf(g), (seen.get(nameOf(g)) ?? 0) + 1);
      ts.results = places.length;
      // a local-specialty search keeps Google's top 8: further down the results drift off topic
      if (Q.local && places.length > 8 && !places[0]?._cached) {
        for (const g of places.slice(8)) dropped.push({ name: ((g.displayName as { text?: string } | undefined)?.text ?? '').trim(), reason: 'beyond the top 8 for a local-specialty search' });
        places = places.slice(0, 8);
      }
      const firstOf = new Set<string>(); // one branch per name in a local-specialty search
      places.forEach((g, rank) => {
        const id = g.id as string;
        const label = ((g.displayName as { text?: string } | undefined)?.text ?? (g._name as string) ?? id ?? '').trim();
        const drop = (reason: string) => void dropped.push({ name: label, reason });
        if (!id) return;
        if (known.has(id)) return drop('already on your lists or rated');
        if (!g._cached) {
          if (isChain(nameOf(g))) return drop('chain');
          if (!Q.local && (seen.get(nameOf(g)) ?? 0) > 1) return drop('same name twice in this search (chain)');
          if (Q.local && firstOf.has(nameOf(g))) return drop('another branch, kept the first');
          firstOf.add(nameOf(g));
          const types = (g.types as string[] | undefined) ?? [];
          const count = (g.userRatingCount as number | undefined) ?? 0;
          if ((g.businessStatus ?? 'OPERATIONAL') !== 'OPERATIONAL') return drop(`not open (${g.businessStatus})`);
          if (!types.some((t) => FOOD.test(t))) return drop(`not food (${types.slice(0, 3).join(', ')})`);
          const notPlace = notAPlaceToEat(g);
          if (notPlace) return drop(`not a place to eat (${notPlace})`);
          const rating = (g.rating as number | undefined) ?? 0;
          if (count >= 20 && rating < 4.3) return drop(`rating ${rating} from ${count} reviews, under 4.3`);
          // away from home, a non-local cuisine has to be a standout
          if (Q.strict && (count < 150 || rating < 4.6)) return drop(`not a standout: ${rating} from ${count} reviews (needs 4.6+ and 150+)`);
          // away from home, few reviews often means few people use Google there, not a new place
          if (away && count < 20 && !Q.local) return drop(`only ${count} Google reviews, away from home`);
          // away from home, a cuisine you save at home is only a side dish: a couple of standouts at most
          if (Q.cap && kept.length >= Q.cap) return drop(`already have ${Q.cap} from this search`);
          const row = toRow(g, itemId, 'Google Maps search', Q.label, null, {
            cuisine: Q.cuisine,
            what_it_says: count < 20 ? (away ? `Only ${reviews(count)} on Google.` : `New: ${reviews(count)} on Google.`) : `${(g.rating as number).toFixed(1)} stars from ${reviews(count)} on Google.`,
          });
          if (row) rows.push(row);
        }
        if (g._cached && Q.cap && kept.length >= Q.cap) return drop(`already have ${Q.cap} from this search`);
        // fit: stronger kinds and higher in the results score higher; quality from Google rating
        // (a reused search has no rating here, so it gets the middle quality)
        const fit = Q.base * (1 - rank / 25);
        const score = 0.6 * fit + 0.4 * quality(g.rating as number, g.userRatingCount as number);
        const reason = Q.reason;
        kept.push(`${label} (${Math.round(score * 100)})`);
        if (!info.has(id)) {
          const types = ((g.types as string[] | undefined) ?? []).filter((t) => !/^(point_of_interest|establishment|food|restaurant)$/.test(t)).slice(0, 3);
          const stars = g.rating ? `${g.rating} stars, ${g.userRatingCount ?? 0} Google reviews` : '';
          info.set(id, { id, name: label, detail: [Q.cuisine, ...types.map((t) => t.replace(/_/g, ' ')), stars].filter(Boolean).join('; ') });
        }
        const prev = scores.get(id);
        if (!prev || score > prev.score) scores.set(id, { google_place_id: id, score: Math.round(score * 1000) / 1000, reason });
      });
    }),
  );

  // away from home: the places the city is famous for, looked up by name
  if (away?.institutions?.length) {
    const found = await findInstitutions(away, input, key, known, deps, trace);
    if (found.item) {
      items.push(found.item);
      searched += found.searched;
    }
    rows.push(...found.rows);
    for (const x of found.places) {
      info.set(x.score.google_place_id, x.info);
      const prev = scores.get(x.score.google_place_id);
      if (!prev || x.score.score > prev.score) scores.set(x.score.google_place_id, x.score);
    }
  }

  const ranked = await rerank(
    [...scores.values()].map((x) => ({ id: x.google_place_id, name: info.get(x.google_place_id)?.name ?? '', detail: info.get(x.google_place_id)?.detail ?? '', score: x.score, reason: x.reason })),
    deps,
    trace,
  );
  await deps.save(items, rows, ranked, key, 'google');
  trace.kind = 'google';
  trace.result = { searched, reused: queries.length - searched, places: scores.size };
  return { mode: 'google', area: key, away: !!away, searched, places: scores.size };
}

// ---------- slow: the web ----------

export function webPrompt(area: string, cuisines: string[], away?: AreaProfile | null, dislikes: string[] = [], vibes: string[] = []): string {
  const noes = dislikes.length
    ? `\nWhen they turned places down, they said: ${dislikes.slice(0, 15).map((d) => `"${d}"`).join('; ')}. Leave out places like those.`
    : '';
  const likes = vibes.length
    ? `\nThe kinds of places they like: ${vibes.slice(0, 12).join(', ')}. Favor places like that when food writers or reviews describe them that way.`
    : '';
  return webPromptBase(area, cuisines, away) + likes + noes + WEB_FORMAT;
}

function webPromptBase(area: string, cuisines: string[], away?: AreaProfile | null): string {
  if (away) {
    return `Find restaurants, cafes, bakeries and bars in or near ${area} for a visitor who travels for food.
Focus on what ${area} is known for and does better than elsewhere: ${[...away.local, ...away.strengths].map((x) => x.name).join(', ')}.
At home they save a lot of ${cuisines.map(nice).join(', ') || 'varied food'}. That reflects where they live, not what they
want here: include those only where ${area} is known for them. Include other non-local food only when the place is a
standout that local food writers single out, or a local take on it. Include the institutions ${area} is famous for
that locals still go to, and mark them "institution": true. Skip chains and tourist traps locals avoid.
Use the local food press, local guides and recent reviews. Places must be open now.`;
  }
  return `Find restaurants, cafes, bakeries and bars in or near ${area} that a visitor with this taste would want to try.
Their favorite cuisines: ${cuisines.map(nice).join(', ') || 'varied'}.
Use the local food press, "best new restaurants" lists, local guides and recent reviews. Prefer places that opened or
got press in the last year, and lesser-known places that fit their cuisines, over famous tourist standbys.
Places must be open now.`;
}

const WEB_FORMAT = `
Return up to 15 places. End your answer with a JSON array in a \`\`\`json block, one object per place:
{"name": "...", "city": "...", "cuisine": "...", "dishes": ["..."],
 "why": "one sentence in your own words on why it fits this person (no quotes from articles)",
 "source": "publication name", "source_title": "article title", "source_url": "..."}`;

export function parseWeb(text: string): { name: string; city: string; cuisine: string; dishes: string[]; why: string; source: string; source_title: string; source_url: string; institution: boolean }[] {
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
        institution: p.institution === true,
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

export async function discoverWeb(input: DiscoverInput, deps: DiscoverDeps, trace: Trace = {}) {
  const key = areaKey(input.lat, input.lng);
  trace.mode = 'web';
  const box = boxAround(input.lat, input.lng, Math.min(Math.max(input.radius_m ?? 6000, 3000), 20000));
  const cached = await deps.cachedQueries(key, CACHE_DAYS);
  const known = await deps.knownIds();
  const cuisines = (await deps.topCuisines()).filter((c) => !TOO_BROAD.has(c)).slice(0, 6);
  const away = await awayProfile(input, deps, trace);
  trace.your_cuisines = cuisines;

  if ([...cached].some((id) => id.startsWith(`here:${key}:w:`))) {
    // the web was searched for this area recently (by anyone): reuse, and score for this user
    const prev = await deps.existingForArea(key, `here:${key}:w:`);
    const fresh = prev.filter((p) => !known.has(p.google_place_id) && !isChain(p.name ?? ''));
    const scores = await rerank(fresh.map((p) => ({ id: p.google_place_id, name: p.name ?? '', detail: [p.cuisine, `from ${p.source}`].filter(Boolean).join('; '), score: 0.55, reason: `From ${p.source}` })), deps, trace);
    await deps.save([], [], scores, key, 'web-cached');
    trace.kind = 'web-cached';
    trace.result = { reused_from_last_30_days: true, places: scores.length };
    return { mode: 'web', area: key, cached: true, places: scores.length };
  }
  const limit = (await deps.webLimit?.().catch(() => null)) ?? WEB_PER_DAY;
  if ((await deps.webRunsToday()) >= limit) {
    trace.kind = 'web-limited';
    trace.limit = limit;
    return { mode: 'web', area: key, places: 0, message: `Web search is limited to ${limit} new areas a day. The quick results are still here.` };
  }

  const dislikes = (await deps.dislikes?.().catch(() => [])) ?? [];
  const vibes = (await deps.vibes?.().catch(() => [])) ?? [];
  const prompt = webPrompt(input.area_name || `the area around ${input.lat.toFixed(3)}, ${input.lng.toFixed(3)}`, cuisines, away, dislikes, vibes);
  trace.kind = 'web'; // counts toward the daily limit even if a later step fails
  trace.prompt = prompt;
  const { text, searches, queries, pages } = await deps.claudeWeb(prompt);
  const found = parseWeb(text);
  const tfound: { name: string; source: string; url: string; result: string }[] = [];
  trace.claude = { searches, queries: queries ?? [], pages: (pages ?? []).slice(0, 60), answer: text.slice(0, 20000) };
  trace.found = tfound;
  const items: { item_id: string; source: string; title: string; link: string | null }[] = [];
  const rows: CandidateRow[] = [];
  const scores: Score[] = [];
  const webInfo = new Map<string, { name: string; detail: string }>(); // for the rerank
  await Promise.all(
    found.map(async (f, i) => {
      const t = { name: f.name, source: f.source, url: f.source_url, result: '' };
      tfound.push(t);
      const drop = (reason: string) => void (t.result = reason);
      if (!/^https?:\/\//.test(f.source_url)) return drop('no source link');
      const res = await deps.googleSearch(`${f.name} ${f.city}`, box, false).catch(() => []);
      const g = res.find((r) => similar(f.name, ((r.displayName as { text?: string } | undefined)?.text ?? '')));
      if (!g) return drop(`not found on Google in the area (Google had: ${res.slice(0, 3).map((r) => (r.displayName as { text?: string } | undefined)?.text).join(', ') || 'nothing'})`);
      if ((g.businessStatus ?? 'OPERATIONAL') !== 'OPERATIONAL') return drop(`not open (${g.businessStatus})`);
      if (notAPlaceToEat(g)) return drop(`not a place to eat (${notAPlaceToEat(g)})`);
      if (isChain(((g.displayName as { text?: string } | undefined)?.text ?? ''))) return drop('chain');
      const itemId = `here:${key}:w:${f.source_url}`.slice(0, 500);
      if (!items.some((x) => x.item_id === itemId)) items.push({ item_id: itemId, source: f.source, title: f.source_title || f.source, link: f.source_url });
      const row = toRow(g, itemId, f.source, f.source_title || f.source, f.source_url, {
        mention_type: 'list_entry', cuisine: f.cuisine || null, dishes: f.dishes, what_it_says: f.why, tone: 'positive',
      });
      if (!row) return drop('no Google id');
      if (known.has(row.google_place_id)) return drop('already on your lists or rated');
      rows.push(row);
      const liked = !!f.cuisine && cuisines.some((c) => f.cuisine.includes(nice(c)) || nice(c).includes(f.cuisine));
      const local = !!away && [...away.local, ...away.strengths].some((sp) => (!!f.cuisine && matches(f.cuisine, sp)) || f.dishes.some((x) => matches(x, sp)));
      const famous = !!away && f.institution;
      // away from home, a cuisine they save at home only counts where this city is known for it
      const score = 0.75 - i * 0.01 + (liked && (!away || local) ? 0.1 : 0) + (local ? 0.1 : 0) + (famous ? 0.15 : 0);
      const city = away?.area ?? input.area_name ?? 'local';
      const where = away?.area ?? input.area_name ?? 'this area';
      const reason = famous ? `A ${city} institution. From ${f.source}`
        : liked && local ? `${cap(f.cuisine)}: you save a lot of it, and ${where} does it especially well. From ${f.source}`
        : local ? `Local specialty. From ${f.source}`
        : liked && !away ? `${cap(f.cuisine)}: one of the cuisines you save most. From ${f.source}`
        : `From ${f.source}`;
      scores.push({ google_place_id: row.google_place_id, score: Math.round(score * 1000) / 1000, reason });
      webInfo.set(row.google_place_id, { name: f.name, detail: [f.cuisine, f.why, `from ${f.source}`].filter(Boolean).join('; ') });
      t.result = `kept (${Math.round(score * 100)}): ${reason}`;
    }),
  );
  if (!items.length) items.push({ item_id: `here:${key}:w:none`, source: 'Web', title: 'No web results', link: null });
  const ranked = await rerank(scores.map((x) => ({ id: x.google_place_id, name: webInfo.get(x.google_place_id)?.name ?? '', detail: webInfo.get(x.google_place_id)?.detail ?? '', score: x.score, reason: x.reason })), deps, trace);
  await deps.save(items, rows, ranked, key, 'web');
  trace.result = { searches, found: found.length, places: scores.length };
  return { mode: 'web', area: key, searches, places: scores.length };
}
