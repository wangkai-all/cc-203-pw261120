'use strict';

/**
 * Time utilities. Everything in the engine is milliseconds since epoch (UTC).
 * Site-local wall-clock time is handled explicitly so that cross-midnight orders
 * and "natural time" utilization are anchored to the site's timezone.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Parse an ISO-8601 timestamp. Returns null for null/empty/invalid input. */
function parseTime(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  // Require an explicit offset or Z; naive local strings are ambiguous in this product.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function iso(ms) {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

/** Round down to the minute. Event payloads are minute-precision by contract. */
function floorMinute(ms) {
  return Math.floor(ms / MINUTE) * MINUTE;
}

// ---------------------------------------------------------------------------
// Timezone helpers (no external dependencies; IANA zones via Intl)
// ---------------------------------------------------------------------------

const fmtCache = new Map();
function zoneFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of the zone at instant `ms`: localWallClock - utc. */
function zoneOffsetAt(ms, tz) {
  const parts = zoneFormatter(tz).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock components of an instant in `tz`. */
function zoneParts(ms, tz) {
  const parts = zoneFormatter(tz).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour'), minute: get('minute'), second: get('second'),
  };
}

/** Epoch ms for a wall-clock date/time in `tz`. */
function zonedTime({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = zoneOffsetAt(guess, tz);
  let t = guess - offset;
  // One correction handles DST transitions for the fixed-point iteration.
  offset = zoneOffsetAt(t, tz);
  t = guess - offset;
  return t;
}

/** Local calendar date string (YYYY-MM-DD) for an instant. */
function localDate(ms, tz) {
  const p = zoneParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Start of the local day containing `ms`. */
function startOfLocalDay(ms, tz) {
  const p = zoneParts(ms, tz);
  return zonedTime({ year: p.year, month: p.month, day: p.day }, tz);
}

/** Add whole calendar days to an instant, preserving local wall-clock time. */
function addLocalDays(ms, days, tz) {
  const p = zoneParts(ms, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  d.setUTCDate(d.getUTCDate() + days);
  return zonedTime({
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: p.hour, minute: p.minute, second: p.second,
  }, tz);
}

/** Enumerate local calendar dates between two instants (end exclusive). */
function enumerateDates(startMs, endMs, tz) {
  const out = [];
  let cursor = startOfLocalDay(startMs, tz);
  let guard = 0;
  while (cursor < endMs && guard < 4000) {
    out.push(localDate(cursor, tz));
    cursor = addLocalDays(cursor, 1, tz);
    guard += 1;
  }
  return out;
}

function localDayBounds(dateStr, tz) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const start = zonedTime({ year, month, day }, tz);
  const next = new Date(Date.UTC(year, month - 1, day));
  next.setUTCDate(next.getUTCDate() + 1);
  const end = zonedTime({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, tz);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Interval set algebra. Intervals are [start, end) in ms.
// ---------------------------------------------------------------------------

function sortIntervals(list) {
  return [...list].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Merge overlapping/adjacent intervals. */
function mergeIntervals(list) {
  const sorted = sortIntervals(list);
  const out = [];
  for (const iv of sorted) {
    if (iv.end <= iv.start) continue;
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

function clipInterval(iv, bound) {
  const start = Math.max(iv.start, bound.start);
  const end = Math.min(iv.end, bound.end);
  return end > start ? { ...iv, start, end } : null;
}

function clipIntervals(list, bound) {
  return list.map((iv) => clipInterval(iv, bound)).filter(Boolean);
}

/** Total measured length. */
function measure(list) {
  return list.reduce((s, iv) => s + Math.max(0, iv.end - iv.start), 0);
}

/** Intersection of two interval sets. */
function intersectIntervals(a, b) {
  const out = [];
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const start = Math.max(A[i].start, B[j].start);
    const end = Math.min(A[i].end, B[j].end);
    if (end > start) out.push({ start, end });
    if (A[i].end <= B[j].end) i += 1; else j += 1;
  }
  return out;
}

/** a minus b (set difference). */
function subtractIntervals(a, b) {
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  const out = [];
  for (const iv of A) {
    let pieces = [{ ...iv }];
    for (const cut of B) {
      const next = [];
      for (const p of pieces) {
        if (cut.end <= p.start || cut.start >= p.end) { next.push(p); continue; }
        if (cut.start > p.start) next.push({ start: p.start, end: cut.start });
        if (cut.end < p.end) next.push({ start: cut.end, end: p.end });
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out.filter((p) => p.end > p.start);
}

/** Union of several interval sets. */
function unionIntervals(...sets) {
  return mergeIntervals(sets.flat());
}

/**
 * Split interval set by day boundaries in `tz`, returning
 * [{date, start, end, ms}] clipped to [boundaryStart, boundaryEnd).
 */
function splitByLocalDay(list, tz, boundary) {
  const out = [];
  for (const iv of clipIntervals(list, boundary)) {
    let cursor = iv.start;
    let guard = 0;
    while (cursor < iv.end && guard < 4000) {
      const dayEnd = addLocalDays(startOfLocalDay(cursor, tz), 1, tz);
      const end = Math.min(iv.end, dayEnd);
      out.push({ date: localDate(cursor, tz), start: cursor, end, ms: end - cursor });
      cursor = end;
      guard += 1;
    }
  }
  return out;
}

module.exports = {
  MINUTE, HOUR, DAY,
  parseTime, iso, floorMinute,
  zoneOffsetAt, zoneParts, zonedTime, localDate, startOfLocalDay, addLocalDays,
  enumerateDates, localDayBounds,
  sortIntervals, mergeIntervals, clipInterval, clipIntervals, measure,
  intersectIntervals, subtractIntervals, unionIntervals, splitByLocalDay,
};
