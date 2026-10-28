import type { OpeningHours } from './supabase';

const WEEK = 7 * 24 * 60;

// Is the place open right now, in its own time zone? null when there are no hours.
export function isOpenNow(h: OpeningHours | null | undefined, now = new Date()): boolean | null {
  if (!h?.periods?.length) return null;
  const offset = h.utcOffsetMinutes ?? -now.getTimezoneOffset();
  const local = new Date(now.getTime() + offset * 60_000); // read with getUTC* = place's local time
  const t = local.getUTCDay() * 1440 + local.getUTCHours() * 60 + local.getUTCMinutes();
  for (const p of h.periods) {
    const start = p.open.day * 1440 + p.open.hour * 60 + p.open.minute;
    if (!p.close) return true; // open around the clock
    let end = p.close.day * 1440 + p.close.hour * 60 + p.close.minute;
    if (end <= start) end += WEEK; // closes after midnight Saturday
    if ((t >= start && t < end) || (t + WEEK >= start && t + WEEK < end)) return true;
  }
  return false;
}

// Today's hours as Google writes them ("Monday: 11:00 AM – 9:00 PM" -> "11:00 AM – 9:00 PM")
export function todaysHours(h: OpeningHours | null | undefined, now = new Date()): string | null {
  const lines = h?.weekdayDescriptions;
  if (!lines?.length) return null;
  const offset = h?.utcOffsetMinutes ?? -now.getTimezoneOffset();
  const day = new Date(now.getTime() + offset * 60_000).getUTCDay(); // 0 = Sunday
  const line = lines[(day + 6) % 7]; // Google lists Monday first
  return line ? line.replace(/^[^:]+:\s*/, '') : null;
}
