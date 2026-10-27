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
};

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
