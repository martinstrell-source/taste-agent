import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Shown instead of the app when app/.env is missing or incomplete
export const configError =
  !url || !key
    ? 'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in app/.env'
    : key.startsWith('sb_secret_')
      ? 'app/.env has the secret key. Use the publishable key (sb_publishable_...) instead.'
      : null;

export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing', {
  auth: {
    storage: AsyncStorage, // stay signed in between launches
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Refresh the sign-in only while the app is in the foreground
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});

// One row from the nearby() database function
export type NearbyPlace = {
  kind: 'saved' | 'pick';
  ref: string;
  name: string;
  address: string | null;
  place_lat: number;
  place_lng: number;
  distance_m: number;
  categories: string[] | null;
  list_name: string | null;
  note: string | null; // the user's note for saves; what the article said for picks
  // added by schema_v4.sql (missing before it is run)
  google_place_id?: string | null;
  rating?: number | null;
  review_count?: number | null;
  price_level?: string | null;
  opening_hours?: OpeningHours | null;
  added_at?: string | null; // saved (or, for picks, first seen)
  added_via?: string | null; // takeout | onboard | capture | pick
  // added by schema_v6.sql: the pick's taste score for this user, and why
  score?: number | null;
  why?: string | null;
  // set in the app for a restaurant chosen from the search bar (not saved, not a pick)
  from_search?: boolean;
};

export type OpeningHours = {
  periods?: { open: { day: number; hour: number; minute: number }; close?: { day: number; hour: number; minute: number } }[];
  weekdayDescriptions?: string[];
  utcOffsetMinutes?: number | null;
};

export type PlaceDetails = Pick<NearbyPlace, 'rating' | 'review_count' | 'price_level' | 'opening_hours'>;

// Rating, price and opening hours from the place-details function (Google, cached on the server).
// Returns {} if the function isn't set up yet, so the app still works without it.
export async function fetchPlaceDetails(ids: string[], hours: boolean): Promise<Record<string, PlaceDetails>> {
  const out: Record<string, PlaceDetails> = {};
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 40) {
    const { data, error } = await supabase.functions.invoke('place-details', {
      body: { ids: unique.slice(i, i + 40), hours },
    });
    if (error || !data?.places) break;
    Object.assign(out, data.places);
  }
  return out;
}

export async function fetchNearby(lat: number, lng: number, radiusM: number): Promise<NearbyPlace[]> {
  const { data, error } = await supabase.rpc('nearby', {
    lat,
    lng,
    radius_m: radiusM,
    max_rows: 200,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as NearbyPlace[];
}
