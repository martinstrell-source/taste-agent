import type { NearbyPlace } from './supabase';

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  // whole numbers without ".0" (radius labels: 1 km, 3 km); one decimal under 10 km otherwise
  return Number.isInteger(km) || km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

const LIST_LABELS: Record<string, string> = {
  favorites: 'Favorite',
  want_to_go: 'Want to go',
  captured: 'Added',
};

export function placeLabel(p: NearbyPlace): string {
  if (p.kind === 'pick') return 'New pick';
  if (!p.list_name) return 'Saved';
  return LIST_LABELS[p.list_name] ?? p.list_name.replace(/_/g, ' ');
}

// Google categories, readable: "italian", "pizza" (skip the generic ones)
const GENERIC = new Set(['restaurant', 'food', 'point of interest', 'establishment', 'store', 'meal takeaway']);
export function categoryText(p: NearbyPlace, max = 3): string {
  const seen = new Set<string>();
  return (p.categories ?? [])
    .map((c) => c.toLowerCase().replace(/_/g, ' ').replace(/ restaurant$/, '').trim())
    .filter((c) => c && !GENERIC.has(c) && !seen.has(c) && !!seen.add(c))
    .slice(0, max)
    .join(', ');
}

// Which group a place belongs to, for colors and the filter
export type Group = 'favorites' | 'want_to_go' | 'other' | 'pick';
export function groupOf(p: NearbyPlace): Group {
  if (p.kind === 'pick') return 'pick';
  if (p.list_name === 'favorites' || p.list_name === 'want_to_go') return p.list_name;
  return 'other';
}

// Rough map zoom that shows a circle of radiusM around the center
export function deltaForRadius(radiusM: number): number {
  return (radiusM * 2.4) / 111_000;
}

// Distance in meters between two points (for "search this area")
export function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

export function mapsUrl(p: NearbyPlace): string {
  // Google Maps app if installed, otherwise the web page; picks carry a Google place id
  const query = encodeURIComponent([p.name, p.address].filter(Boolean).join(', '));
  const placeId = p.kind === 'pick' ? `&query_place_id=${encodeURIComponent(p.ref)}` : '';
  return `https://www.google.com/maps/search/?api=1&query=${query}${placeId}`;
}

export const GROUP_LABEL: Record<Group, string> = {
  favorites: 'Favorites',
  want_to_go: 'Want to go',
  other: 'Other lists',
  pick: 'New picks',
};

// ---------- Google details: price, rating ----------

const PRICE: Record<string, string> = {
  PRICE_LEVEL_FREE: 'Free',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};
export const PRICE_STEPS = ['$', '$$', '$$$', '$$$$'] as const;

export function priceText(level?: string | null): string | null {
  return level ? (PRICE[level] ?? null) : null;
}

// "4.6 ★ (812)" or "New: 12 reviews" (ratings mean little with few reviews)
export function ratingText(rating?: number | null, count?: number | null): string | null {
  if (!rating) return null;
  if ((count ?? 0) < 20) return `New: ${count ?? 0} reviews`;
  return `${rating.toFixed(1)} ★ (${(count ?? 0).toLocaleString()})`;
}

// ---------- food vs. drinks and sweets ----------

const DRINK_SWEET = new Set([
  'bar', 'wine_bar', 'cocktail_bar', 'pub', 'brewery', 'brewpub', 'beer_garden', 'lounge_bar', 'night_club',
  'cafe', 'coffee_shop', 'coffee_roastery', 'tea_house', 'juice_shop', 'bakery', 'dessert_shop', 'dessert_restaurant',
  'ice_cream_shop', 'confectionery', 'donut_shop', 'chocolate_shop', 'candy_store', 'cake_shop', 'bagel_shop',
]);
export type Kind = 'all' | 'food' | 'drink';

// "drink" = drinks and sweets: bars, cafes, bakeries, dessert. A cafe that is also a restaurant counts as food.
export function kindOf(p: NearbyPlace): 'food' | 'drink' {
  const cats = p.categories ?? [];
  const isRestaurant = cats.some(
    (c) => (c === 'restaurant' || c.endsWith('_restaurant')) && !DRINK_SWEET.has(c),
  );
  if (isRestaurant) return 'food';
  return cats.some((c) => DRINK_SWEET.has(c)) ? 'drink' : 'food';
}

// ---------- where a place came from ----------

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function sourceLine(p: NearbyPlace): string | null {
  if (p.kind === 'pick') return p.added_at ? `First seen ${shortDate(p.added_at)}` : null;
  if (p.added_via === 'takeout') {
    const list = p.list_name === 'favorites' ? 'Favorites' : p.list_name === 'want_to_go' ? 'Want to go' : (p.list_name ?? '').replace(/_/g, ' ');
    return `From your Google ${list} list`;
  }
  return p.added_at ? `Saved ${shortDate(p.added_at)}` : null;
}
