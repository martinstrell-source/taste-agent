import { supabase } from './supabase';

// "Your taste": what the app has learned, with the user's own edits on top. The weekly rebuild on the
// Mac mini reads the same edits (user_prefs), so they stick:
//   cuisine / dish / dislike_other   added by the user (onboarding or here)
//   not_cuisine / not_dish           "not really me": hidden from what the app inferred

type Pref = { kind: string; value: string };
export type TasteCuisine = { cuisine: string; label: string; score: number; added: boolean };
export type Taste = {
  cuisines: TasteCuisine[]; // most telling first
  hiddenCuisines: string[];
  dishes: { dish: string; added: boolean }[];
  hiddenDishes: string[];
  avoid: string[];
  vibes: string[]; // kinds of places they like: hole in the wall, rooftop
  noes: { google_place_id: string; name: string | null; note: string }[];
  placesCounted: number;
};

const normC = (c: string) => c.trim().toLowerCase().replace(/-/g, ' ').replace(/ /g, '_');
export const cuisineLabel = (c: string) => {
  const s = c.replace(/_/g, ' ').replace(/\//g, ' / ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// as the server's liftScore / rankCuisines: half how much more often than a typical diner, half volume
const BASE: Record<string, number> = {
  american: 0.15, chinese: 0.1, mexican: 0.1, italian: 0.07, japanese: 0.07, pizza: 0.06, burgers: 0.04, thai: 0.04,
  indian: 0.04, vietnamese: 0.04, korean: 0.03, mediterranean: 0.03, seafood: 0.03, french: 0.02, bbq: 0.02,
  middle_eastern: 0.02, californian: 0.03, 'uyghur/central_asian': 0.002,
};
function lift(share: number, base: number, max: number) {
  if (share <= 0) return 0;
  const l = share / base;
  const distinct = l > 1 ? Math.max(0, Math.min(1, Math.log(l) / Math.log(8))) : 0;
  return 0.5 * distinct + 0.5 * Math.min(1, share / max);
}

async function uid(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('Not signed in');
  return data.user.id;
}

export async function loadTaste(): Promise<Taste> {
  const [prof, prefsR, baseR, noesR] = await Promise.all([
    supabase.from('user_profiles').select('profile').maybeSingle(),
    supabase.from('user_prefs').select('kind, value'),
    supabase.from('cuisine_base').select('cuisine, share, pool_size'),
    supabase.from('feedback').select('google_place_id, name, note').in('reaction', ['meh', 'no']).not('note', 'is', null).order('created_at', { ascending: false }).limit(40),
  ]);
  const p = typeof prof.data?.profile === 'string' ? JSON.parse(prof.data.profile) : prof.data?.profile;
  const prefs = (prefsR.data ?? []) as Pref[];
  const has = (kind: string) => new Set(prefs.filter((x) => x.kind === kind).map((x) => (kind.endsWith('cuisine') ? normC(x.value) : x.value.trim().toLowerCase())));
  const hideC = has('not_cuisine');
  const hideD = has('not_dish');
  const addedC = has('cuisine');
  const addedD = has('dish');

  const shares: Record<string, number> = {};
  for (const [c, v] of Object.entries((p?.cuisines ?? {}) as Record<string, { share?: number }>)) if (!hideC.has(c)) shares[c] = v?.share ?? 0;
  const top = Math.max(0.05, ...Object.values(shares));
  for (const c of addedC) if (!hideC.has(c) && !(c in shares)) shares[c] = top / 2;
  const base = { ...BASE };
  const rows = (baseR.data ?? []) as { cuisine: string; share: number; pool_size: number }[];
  if ((rows[0]?.pool_size ?? 0) >= 300) for (const r of rows) base[r.cuisine] = r.share;
  const max = Math.max(0, ...Object.values(shares)) || 1;
  const cuisines = Object.entries(shares)
    .map(([c, s]) => ({ cuisine: c, label: cuisineLabel(c), score: lift(s, Math.max(0.002, base[c] ?? 0.01), max), added: addedC.has(c) }))
    .sort((a, b) => b.score - a.score)
    // the top 12, plus anything the user added themselves (it may rank lower until the weekly rebuild)
    .filter((c, i) => i < 12 || c.added);

  // dishes the user added come first, so a new one shows right away (the list is cut at 15)
  const dishes = [...new Set([...addedD, ...Object.keys(p?.dishes ?? {})])]
    .filter((d) => d && !hideD.has(d))
    .slice(0, 15)
    .map((d) => ({ dish: d, added: addedD.has(d) }));

  return {
    cuisines,
    hiddenCuisines: [...hideC],
    dishes,
    hiddenDishes: [...hideD],
    avoid: prefs.filter((x) => x.kind.startsWith('dislike_')).map((x) => x.value),
    vibes: prefs.filter((x) => x.kind === 'vibe').map((x) => x.value),
    noes: ((noesR.data ?? []) as { google_place_id: string; name: string | null; note: string }[]).filter((n) => n.note?.trim()),
    placesCounted: Math.round(p?.n_food_places ?? 0),
  };
}

async function addPref(kind: string, value: string) {
  const v = value.trim();
  if (!v) return;
  const { error } = await supabase.from('user_prefs').upsert({ user_id: await uid(), kind, value: v }, { onConflict: 'user_id,kind,value', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}
async function removePref(kinds: string[], value: string) {
  const { error } = await supabase.from('user_prefs').delete().in('kind', kinds).ilike('value', value.trim());
  if (error) throw new Error(error.message);
}

// cuisines: hide one the app inferred, bring it back, or add one
export async function hideCuisine(c: string) {
  await removePref(['cuisine'], c.replace(/_/g, ' '));
  await removePref(['cuisine'], c);
  await addPref('not_cuisine', c);
}
export const unhideCuisine = (c: string) => removePref(['not_cuisine'], c);
export async function addCuisine(c: string) {
  const v = normC(c);
  await removePref(['not_cuisine'], v);
  await addPref('cuisine', v);
}

export async function hideDish(d: string) {
  await removePref(['dish'], d);
  await addPref('not_dish', d.toLowerCase());
}
export const unhideDish = (d: string) => removePref(['not_dish'], d);
export async function addDish(d: string) {
  await removePref(['not_dish'], d);
  await addPref('dish', d.toLowerCase());
}

// the kinds of places they like (setting and feel, not food)
export const VIBE_IDEAS = ['Hole in the wall', 'Easy to miss', 'Rooftop', 'Outdoor patio', 'Counter seating', 'Lively', 'Quiet', 'Old-school', 'Natural wine bar'];
export const addVibe = (text: string) => addPref('vibe', text);
export const removeVibe = (text: string) => removePref(['vibe'], text);

export const addAvoid = (text: string) => addPref('dislike_other', text);
export const removeAvoid = (text: string) => removePref(['dislike_other', 'dislike_cuisine', 'dislike_dish', 'dislike_format'], text);

// forget the reason given for a "Not for me" (the place stays out of suggestions)
export async function forgetReason(googleId: string) {
  const { error } = await supabase.from('feedback').update({ note: null }).eq('google_place_id', googleId);
  if (error) throw new Error(error.message);
}
