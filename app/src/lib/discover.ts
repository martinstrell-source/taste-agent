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

// the phone can give up on a long web search while the server finishes it and saves the picks
export function isTimeout(e: unknown): boolean {
  return /Failed to send a request|network request failed|timed out|timeout/i.test((e as Error)?.message ?? '');
}

// same 5 km cells as the server (discover.ts areaKey)
function areaKey(lat: number, lng: number): string {
  return `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lng * 20) / 20).toFixed(2)}`;
}

// After a timeout: watch this user's run for the area until the server finishes it (every 8 s, up to 4 min).
// Returns how many places it added, or null if it never finished.
export async function waitForWebRun(lat: number, lng: number, startedAt: number): Promise<{ places: number; message?: string } | null> {
  const since = new Date(startedAt - 120_000).toISOString(); // allow for the phone's clock being off
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    const { data } = await supabase
      .from('discover_runs')
      .select('kind, error, trace')
      .eq('area_key', areaKey(lat, lng))
      .like('kind', 'web%')
      .gte('created_at', since)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data || data.kind === 'web-started') continue;
    if (data.error) return { places: 0, message: `The web search failed: ${data.error}` };
    const r = (data.trace as { result?: { places?: number } } | null)?.result;
    return { places: r?.places ?? 0 };
  }
  return null;
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
