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
export type AreaProfile = { size?: string; local: Specialty[]; strengths: Specialty[] }; // size: major | mid | small

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
};

export type Box = { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };

export const CACHE_DAYS = 30;
export const WEB_PER_DAY = 3;
export const AWAY_KM = 100;
const TOO_BROAD = new Set(['american', 'asian', 'european', 'fusion', 'cafe', 'restaurant', 'breakfast', 'brunch']);
// global chains: never a discovery, home or away
const CHAINS = /^(pizza hut|kfc|mcdonald'?s|starbucks|domino'?s|subway|burger king|papa john'?s|dunkin'?|taco bell|wendy'?s|tim hortons|costa coffee|dairy queen|hard rock cafe|five guys|shake shack|popeyes|chick-fil-a|little caesars|panda express|chipotle|sizzler|tgi friday'?s|outback steakhouse|haagen-dazs|baskin-robbins|krispy kreme|7-eleven|family ?mart|lawson|luckin coffee|mixue|yoshinoya|sukiya|matsuya|coco ichibanya|saizeriya)\b/i;
export function isChain(name: string): boolean {
  return CHAINS.test(name.trim().replace(/[’`]/g, "'"));
}
const FOOD = /restaurant|food|cafe|coffee|bakery|bar|pub|brewery|winery|meal_|ice_cream|dessert|tea|juice|deli|confectionery|donut|bagel/;

// ---------- what the user said no to ----------

export function dislikePrompt(dislikes: string[], places: { id: string; name: string; detail: string }[]): string {
  return `Someone uses an app that suggests restaurants. When they turned suggestions down, they said:
${dislikes.map((d) => `- ${d}`).join('\n')}

Here are new suggestions for them (name, then what Google or an article says about it):
${places.map((p, i) => `${i + 1}. ${p.name}${p.detail ? ` (${p.detail})` : ''}`).join('\n')}

Which of these would they most likely turn down for the same reasons? Only flag a place when the name or details
make it clear (a reason like "too far" or "too pricey" for one place says little about others). Most should stay.
Answer with only a JSON array: [{"n": <number>, "why": "a few words"}]. Use [] if none.`;
}

// one fast Claude call: ids to leave out, with the reason, recorded in the trace
export async function screenDislikes(
  places: { id: string; name: string; detail: string }[],
  deps: DiscoverDeps,
  trace: Trace,
): Promise<Set<string>> {
  const out = new Set<string>();
  const dislikes = (await deps.dislikes?.().catch(() => [])) ?? [];
  if (!dislikes.length || !places.length) return out;
  const list = places.slice(0, 60);
  const answer = await deps.claudeText(dislikePrompt(dislikes, list)).catch(() => '');
  const dropped: { name: string; why: string }[] = [];
  try {
    const m = answer.match(/\[[\s\S]*\]/);
    for (const x of JSON.parse(m ? m[0] : '[]')) {
      const p = list[Number(x?.n) - 1];
      if (p && !out.has(p.id)) {
        out.add(p.id);
        dropped.push({ name: p.name, why: String(x?.why ?? '') });
      }
    }
  } catch {
    // unreadable answer: keep everything
  }
  trace.your_noes = { said: dislikes, left_out: dropped };
  return out;
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
Return only JSON, no other text:
{"size": "major", "local": [{"name": "Peking roast duck", "query": "peking roast duck restaurant", "tags": ["peking duck", "roast duck", "beijing", "chinese"]}],
 "strengths": [{"name": "...", "query": "...", "tags": ["..."]}]}
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
    const p = { size, local: list(d.local, 6), strengths: list(d.strengths, 3) };
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
  if (have?.size) { // profiles saved before size was asked get asked again once
    trace.city_profile = { city_key: ck, from: 'saved', ...have };
    return have;
  }
  const area = input.area_name || `the area around ${input.lat.toFixed(2)}, ${input.lng.toFixed(2)}`;
  const answer = await deps.claudeText(areaPrompt(area)).catch((e) => `error: ${(e as Error).message}`);
  const p = parseAreaProfile(answer);
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
  type Q = { c: string; q: string; label: string; cuisine: string | null; base: number; strict: boolean; local?: boolean; reason: string };
  let queries: Q[];
  if (!away) {
    const cuisines = all.slice(0, 5);
    queries = [
      ...cuisines.map((c, i) => ({ c, q: `${nice(c)} restaurant`, label: `${nice(c)} near ${here}`, cuisine: c, base: 1 - i / 7, strict: false, reason: `${cap(nice(c))}, one of your top cuisines` })),
      { c: 'best', q: 'best restaurants', label: 'Well rated nearby', cuisine: null, base: 0.35, strict: false, reason: 'Well rated nearby' },
    ];
  } else {
    const specials = [...away.local, ...away.strengths];
    const yoursLocal = all.slice(0, 8).filter((c) => specials.some((sp) => matches(c, sp))).slice(0, 3);
    const other = all.slice(0, 5).find((c) => !yoursLocal.includes(c));
    queries = [
      ...away.local.slice(0, 5).map((sp, i) => ({ c: `local-${slug(sp.name)}`, q: sp.query, label: `${sp.name} in ${here}`, cuisine: sp.name.toLowerCase(), base: 1 - i / 12, strict: false, local: true, reason: `Local specialty: ${sp.name}` })),
      ...yoursLocal.map((c) => ({ c, q: `${nice(c)} restaurant`, label: `${nice(c)} near ${here}`, cuisine: c, base: 1, strict: false, reason: `${cap(nice(c))}, one of yours and a local strength` })),
      ...away.strengths.slice(0, 2).map((sp) => ({ c: `strength-${slug(sp.name)}`, q: sp.query, label: `${sp.name} in ${here}`, cuisine: sp.name.toLowerCase(), base: 0.8, strict: false, reason: `${sp.name}: something ${here} does especially well` })),
      // a non-local standout only in a major food city; a 4.6 rating means little in a small market
      ...(other && away.size === 'major' ? [{ c: `${other}:standout`, q: `${nice(other)} restaurant`, label: `${nice(other)} near ${here}`, cuisine: other, base: 0.5, strict: true, reason: `${cap(nice(other))}, one of your top cuisines, and a standout here` }] : []),
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
          const rating = (g.rating as number | undefined) ?? 0;
          if (count >= 20 && rating < 4.3) return drop(`rating ${rating} from ${count} reviews, under 4.3`);
          // away from home, a non-local cuisine has to be a standout
          if (Q.strict && (count < 150 || rating < 4.6)) return drop(`not a standout: ${rating} from ${count} reviews (needs 4.6+ and 150+)`);
          // away from home, few reviews often means few people use Google there, not a new place
          if (away && count < 20 && !Q.local) return drop(`only ${count} Google reviews, away from home`);
          const row = toRow(g, itemId, 'Google Maps search', Q.label, null, {
            cuisine: Q.cuisine,
            what_it_says: count < 20 ? (away ? `Only ${count} reviews on Google.` : `New: ${count} reviews on Google.`) : `${(g.rating as number).toFixed(1)} stars from ${count} reviews on Google.`,
          });
          if (row) rows.push(row);
        }
        // fit: stronger kinds and higher in the results score higher; quality from Google rating
        // (a reused search has no rating here, so it gets the middle quality)
        const fit = Q.base * (1 - rank / 25);
        const score = 0.6 * fit + 0.4 * quality(g.rating as number, g.userRatingCount as number);
        const reason = Q.reason;
        kept.push(`${label} (${Math.round(score * 100)})`);
        if (!info.has(id)) {
          const types = ((g.types as string[] | undefined) ?? []).filter((t) => !/^(point_of_interest|establishment|food|restaurant)$/.test(t)).slice(0, 3);
          info.set(id, { id, name: label, detail: [Q.cuisine, ...types.map((t) => t.replace(/_/g, ' '))].filter(Boolean).join('; ') });
        }
        const prev = scores.get(id);
        if (!prev || score > prev.score) scores.set(id, { google_place_id: id, score: Math.round(score * 1000) / 1000, reason });
      });
    }),
  );

  const no = await screenDislikes([...info.values()].filter((p) => scores.has(p.id)), deps, trace);
  await deps.save(items, rows, [...scores.values()].filter((x) => !no.has(x.google_place_id)), key, 'google');
  trace.kind = 'google';
  trace.result = { searched, reused: queries.length - searched, places: scores.size };
  return { mode: 'google', area: key, away: !!away, searched, places: scores.size };
}

// ---------- slow: the web ----------

export function webPrompt(area: string, cuisines: string[], away?: AreaProfile | null, dislikes: string[] = []): string {
  const noes = dislikes.length
    ? `\nWhen they turned places down, they said: ${dislikes.slice(0, 15).map((d) => `"${d}"`).join('; ')}. Leave out places like those.`
    : '';
  return webPromptBase(area, cuisines, away) + noes + WEB_FORMAT;
}

function webPromptBase(area: string, cuisines: string[], away?: AreaProfile | null): string {
  if (away) {
    return `Find restaurants, cafes, bakeries and bars in or near ${area} for a visitor who travels for food.
Their favorite cuisines: ${cuisines.map(nice).join(', ') || 'varied'}.
Favor what ${area} is known for and does better than elsewhere: ${[...away.local, ...away.strengths].map((x) => x.name).join(', ')}.
Their favorite cuisines count when they are also strong here. Include other non-local food only when the place is a
standout that local food writers single out, or a local take on it. Skip chains and famous tourist standbys.
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
    const no = await screenDislikes(fresh.map((p) => ({ id: p.google_place_id, name: p.name ?? '', detail: p.cuisine ?? '' })), deps, trace);
    const scores = fresh
      .filter((p) => !no.has(p.google_place_id))
      .map((p) => ({ google_place_id: p.google_place_id, score: 0.55, reason: `From ${p.source}` }));
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
  const prompt = webPrompt(input.area_name || `the area around ${input.lat.toFixed(3)}, ${input.lng.toFixed(3)}`, cuisines, away, dislikes);
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
      const score = 0.75 - i * 0.01 + (liked ? 0.1 : 0) + (local ? 0.1 : 0);
      const reason = liked && local ? `${cap(f.cuisine)}, one of yours and a local strength; from ${f.source}`
        : local ? `Local specialty; from ${f.source}`
        : liked ? `${cap(f.cuisine)}, a favorite of yours; from ${f.source}`
        : `From ${f.source}`;
      scores.push({ google_place_id: row.google_place_id, score: Math.round(score * 1000) / 1000, reason });
      t.result = `kept (${Math.round(score * 100)}): ${reason}`;
    }),
  );
  if (!items.length) items.push({ item_id: `here:${key}:w:none`, source: 'Web', title: 'No web results', link: null });
  await deps.save(items, rows, scores, key, 'web');
  trace.result = { searches, found: found.length, places: scores.length };
  return { mode: 'web', area: key, searches, places: scores.length };
}
