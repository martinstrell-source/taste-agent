import * as Location from 'expo-location';

import { supabase } from './supabase';

export type DiscoverResult = { mode: string; area: string; places: number; cached?: boolean; message?: string };

// Quick ("google") or slow ("web") discovery around a point, through the capture function
export async function runDiscover(mode: 'google' | 'web', lat: number, lng: number, radiusM: number, areaName?: string): Promise<DiscoverResult> {
  const { data, error } = await supabase.functions.invoke('capture', {
    body: { type: 'discover', mode, lat, lng, radius_m: radiusM, area_name: areaName },
  });
  if (error) {
    let detail = '';
    try {
      detail = (await (error as { context?: Response }).context?.json())?.error ?? '';
    } catch {
      /* no body */
    }
    if (/type must be/.test(detail)) throw new Error('Discover needs the updated capture function deployed in Supabase.');
    throw new Error(detail || error.message);
  }
  return data as DiscoverResult;
}

// "Portland, Oregon" or "Rockridge, Oakland": helps the web search and the status line
export async function areaName(lat: number, lng: number): Promise<string | undefined> {
  try {
    const [a] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    if (!a) return undefined;
    const place = a.district && a.city && a.district !== a.city ? `${a.district}, ${a.city}` : a.city ?? a.subregion ?? undefined;
    return [place, a.region].filter(Boolean).join(', ') || undefined;
  } catch {
    return undefined;
  }
}
