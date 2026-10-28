// "Add a place": find the place(s) in a link, pasted text, a photo or a friend's tip, and suggest
// Google matches for each. Pure logic with injected network calls so it can be tested; index.ts wires it up.

export type Input = {
  type: 'link' | 'text' | 'photo' | 'friend' | 'bill' | 'discover';
  url?: string;
  text?: string;
  friend?: string; // for type "friend": who recommended it
  image_base64?: string; // for type "photo": JPEG, already resized on the phone
  lat?: number; // where the user is (or where the photo was taken)
  lng?: number;
};

export type Candidate = {
  google_place_id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  categories: string[];
  is_food: boolean;
  open: boolean;
};

export type Found = {
  name: string;
  location_hint: string;
  note: string; // what the source said about it, in plain words
  dishes: string[];
  candidates: Candidate[];
};

export type Source = { type: string; name: string | null; url: string | null };
export type Result = { source: Source; places: Found[]; message?: string };

// ---------- reading a bill (Log a visit) ----------

export type BillItem = { name: string; qty: number; price: number | null };
export type Bill = { restaurant: string | null; date: string | null; items: BillItem[]; subtotal: number | null; tax: number | null; tip: number | null; total: number | null };

export const BILL_PROMPT = `This is a photo of a restaurant bill or receipt. List what was ordered.
Answer with JSON only:
{"restaurant": "name on the bill or null", "date": "YYYY-MM-DD or null",
 "items": [{"name": "item as written, cleaned up", "qty": 1, "price": 12.5}],
 "subtotal": number or null, "tax": number or null, "tip": number or null, "total": number or null}
Prices are the line totals in the bill's currency, numbers only. Leave out discounts, fees and payment lines.
Never include card numbers, card types, authorization codes, names of the card holder or server, or any payment details.`;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

export function parseBill(text: string): Bill {
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const d = JSON.parse(raw);
    const items = (Array.isArray(d.items) ? d.items : [])
      .filter((i: { name?: unknown }) => typeof i?.name === 'string' && i.name.trim())
      // nothing that looks like a card number survives, even if it slipped into an item name
      .filter((i: { name: string }) => !/\d{4}[ -]?\d{4}|x{4}|\*{4}|visa|mastercard|amex|auth/i.test(i.name))
      .slice(0, 40)
      .map((i: { name: string; qty?: unknown; price?: unknown }) => ({
        name: i.name.trim(),
        qty: typeof i.qty === 'number' && i.qty > 0 ? i.qty : 1,
        price: num(i.price),
      }));
    const date = typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null;
    return {
      restaurant: typeof d.restaurant === 'string' ? d.restaurant : null,
      date, items, subtotal: num(d.subtotal), tax: num(d.tax), tip: num(d.tip), total: num(d.total),
    };
  } catch {
    return { restaurant: null, date: null, items: [], subtotal: null, tax: null, tip: null, total: null };
  }
}

export type Deps = {
  fetchPage: (url: string) => Promise<{ finalUrl: string; status: number; html: string }>;
  claude: (content: unknown[], noSystem?: boolean) => Promise<string>; // returns Claude's text answer
  googleSearch: (query: string, bias?: { lat: number; lng: number }) => Promise<Record<string, unknown>[]>;
  shorthand?: { term: string; name: string; type: string }[]; // the user's own names ("A" = Alex)
};

const MAX_PLACES = 10;
const FOOD = /restaurant|food|cafe|coffee|bakery|bar|pub|brewery|winery|meal_|ice_cream|dessert|tea|juice|deli|market|confectionery|donut|bagel/;

// ---------- reading a link ----------

export function isMapsUrl(u: string): boolean {
  return /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(u);
}

// "https://www.google.com/maps/place/Taste+of+Urumqi/@37.79,-122.41,17z/..." -> name and point
export function parseMapsUrl(u: string): { name: string | null; lat: number | null; lng: number | null } {
  let name: string | null = null;
  const m = u.match(/\/maps\/place\/([^/@?]+)/);
  if (m) name = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() || null;
  if (!name) {
    const q = u.match(/[?&]q=([^&]+)/);
    if (q) name = decodeURIComponent(q[1].replace(/\+/g, ' ')).trim() || null;
  }
  const at = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ?? u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  return { name, lat: at ? Number(at[1]) : null, lng: at ? Number(at[2]) : null };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Title, description, site name and readable text from a page
export function pageText(html: string, limit = 15000): { title: string; site: string; text: string } {
  const meta = (prop: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
    return decodeEntities((html.match(re)?.[1] ?? html.match(re2)?.[1] ?? '').trim());
  };
  const title = meta('og:title') || decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '');
  const site = meta('og:site_name');
  const desc = meta('og:description') || meta('description');
  const body = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|header|footer|nav)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
  return { title, site, text: [title, desc, body].filter(Boolean).join('\n\n').slice(0, limit) };
}

// ---------- asking Claude ----------

export const SYSTEM = `You help someone save food and drink places they want to try. From what they give you
(a web page, pasted text, a friend's tip, or a photo), list each specific restaurant, cafe, bakery, bar,
food truck or food shop it names or shows. Skip places only mentioned in passing (as a comparison, or
"formerly X"). For a storefront photo, read the business name from the sign. For a screenshot, read the text.

Answer with JSON only, no other text:
{"source": {"type": "person" | "publication" | "community" | "creator" | "walk_by" | "other", "name": "..." or null},
 "places": [{"name": "...", "location_hint": "neighborhood, street or city if given, else empty",
             "note": "one short sentence in your own words: what it is and what was said about it",
             "dishes": ["dishes or drinks named for this place"]}]}
At most 10 places. If there are none, return an empty list.`;

export function parseClaude(text: string): { source: { type: string; name: string | null }; places: Omit<Found, 'candidates'>[] } {
  const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const d = JSON.parse(raw);
    const places = (Array.isArray(d.places) ? d.places : [])
      .filter((p: { name?: unknown }) => typeof p?.name === 'string' && p.name.trim())
      .slice(0, MAX_PLACES)
      .map((p: { name: string; location_hint?: string; note?: string; dishes?: unknown }) => ({
        name: p.name.trim(),
        location_hint: (p.location_hint ?? '').trim(),
        note: (p.note ?? '').trim(),
        dishes: Array.isArray(p.dishes) ? p.dishes.filter((x): x is string => typeof x === 'string').slice(0, 8) : [],
      }));
    return { source: { type: d.source?.type ?? 'other', name: d.source?.name ?? null }, places };
  } catch {
    return { source: { type: 'other', name: null }, places: [] };
  }
}

// ---------- matching on Google ----------

export function toCandidate(g: Record<string, unknown>): Candidate | null {
  const id = g.id as string | undefined;
  if (!id) return null;
  const loc = (g.location ?? {}) as { latitude?: number; longitude?: number };
  const types = (g.types as string[] | undefined) ?? [];
  return {
    google_place_id: id,
    name: ((g.displayName as { text?: string } | undefined)?.text ?? '').trim(),
    address: (g.formattedAddress as string | undefined) ?? null,
    lat: loc.latitude ?? null,
    lng: loc.longitude ?? null,
    categories: types,
    is_food: types.some((t) => FOOD.test(t)),
    open: ((g.businessStatus as string | undefined) ?? 'OPERATIONAL') === 'OPERATIONAL',
  };
}

async function matchOnGoogle(name: string, hint: string, bias: { lat: number; lng: number } | undefined, deps: Deps) {
  const results = await deps.googleSearch([name, hint].filter(Boolean).join(' '), bias);
  return results
    .map(toCandidate)
    .filter((c): c is Candidate => !!c)
    .sort((a, b) => Number(b.is_food) - Number(a.is_food) || Number(b.open) - Number(a.open)) // food and open first
    .slice(0, 3);
}

// ---------- the whole thing ----------

export async function readBill(input: Input, deps: Deps): Promise<{ bill: Bill; message?: string }> {
  if (!input.image_base64) return { bill: parseBill(''), message: 'No photo received.' };
  const text = await deps.claude([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image_base64 } },
    { type: 'text', text: BILL_PROMPT },
  ], true);
  const bill = parseBill(text);
  return { bill, message: bill.items.length ? undefined : "Couldn't read items from that photo. Try a sharper, flatter shot." };
}

export async function capture(input: Input, deps: Deps): Promise<Result> {
  const bias = typeof input.lat === 'number' && typeof input.lng === 'number' ? { lat: input.lat, lng: input.lng } : undefined;
  const shorthand = (deps.shorthand ?? []).map((s) => `"${s.term}" means ${s.name} (${s.type})`).join('; ');
  const known = shorthand ? `\nThe user's own shorthand: ${shorthand}.` : '';

  if (input.type === 'link') {
    const url = (input.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return { source: { type: 'other', name: null, url: null }, places: [], message: 'That doesn\'t look like a link.' };
    const page = await deps.fetchPage(url).catch(() => null);
    const finalUrl = page?.finalUrl ?? url;

    // a Google Maps link names one place: no need for Claude
    if (isMapsUrl(finalUrl) || isMapsUrl(url)) {
      const m = parseMapsUrl(finalUrl);
      const name = m.name ?? (page ? pageText(page.html).title.replace(/ - Google Maps$/, '') : '');
      if (!name) return { source: { type: 'other', name: 'Google Maps', url }, places: [], message: 'Could not read that Maps link. Try pasting the place name.' };
      const near = m.lat !== null && m.lng !== null ? { lat: m.lat, lng: m.lng } : bias;
      return {
        source: { type: 'other', name: 'Google Maps', url },
        places: [{ name, location_hint: '', note: '', dishes: [], candidates: await matchOnGoogle(name, '', near, deps) }],
      };
    }

    const readable = page && page.status < 400 ? pageText(page.html) : null;
    if (!readable || readable.text.length < 200) {
      return {
        source: { type: 'other', name: null, url },
        places: [],
        message: 'That site doesn\'t let apps read it (Instagram often does this). Paste the caption or text, or add a screenshot as a photo.',
      };
    }
    const answer = await deps.claude([
      { type: 'text', text: `A web page the user wants to save places from.${known}\nURL: ${url}\nSite: ${readable.site}\n\n${readable.text}` },
    ]);
    const parsed = parseClaude(answer);
    const places = await Promise.all(parsed.places.map(async (p) => ({ ...p, candidates: await matchOnGoogle(p.name, p.location_hint, bias, deps) })));
    return {
      source: { type: parsed.source.type === 'other' ? 'publication' : parsed.source.type, name: readable.site || parsed.source.name || new URL(url).hostname.replace(/^www\./, ''), url },
      places,
      message: places.length ? undefined : 'No places found on that page.',
    };
  }

  let content: unknown[];
  if (input.type === 'photo') {
    if (!input.image_base64) return { source: { type: 'walk_by', name: null, url: null }, places: [], message: 'No photo received.' };
    content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image_base64 } },
      { type: 'text', text: `A photo the user took or a screenshot they saved: a storefront, menu, or a post about a place.${known}${input.text ? `\nThey added: ${input.text}` : ''}` },
    ];
  } else {
    const text = (input.text ?? '').trim();
    if (!text) return { source: { type: 'other', name: null, url: null }, places: [], message: 'Nothing to read yet.' };
    const who = input.type === 'friend' && input.friend ? `A recommendation from ${input.friend.trim()}.` : 'Text the user pasted (a post, comment, message or note).';
    content = [{ type: 'text', text: `${who}${known}\n\n${text.slice(0, 15000)}` }];
  }

  const parsed = parseClaude(await deps.claude(content));
  const places = await Promise.all(parsed.places.map(async (p) => ({ ...p, candidates: await matchOnGoogle(p.name, p.location_hint, bias, deps) })));
  const source: Source =
    input.type === 'friend'
      ? { type: 'person', name: input.friend?.trim() || parsed.source.name, url: null }
      : input.type === 'photo'
        ? { type: parsed.source.type === 'other' ? 'walk_by' : parsed.source.type, name: parsed.source.name, url: null }
        : { type: parsed.source.type, name: parsed.source.name, url: null };
  return { source, places, message: places.length ? undefined : 'No places found. Try adding the name or a bit more text.' };
}
