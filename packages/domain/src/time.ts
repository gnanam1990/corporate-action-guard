/**
 * Time.
 *
 * Every instant in this system is a UTC instant represented as integer milliseconds since
 * the Unix epoch. There is no local time anywhere below the display boundary, and no
 * function here reads the clock — `now` is always supplied by the caller. That is what
 * makes replay reproducible and tests timezone-independent.
 *
 * ISO parsing and formatting are implemented with integer arithmetic rather than `Date`.
 * `Date` is banned in this package by lint, and routing around the ban via `globalThis`
 * would defeat the point: a hand-written civil-date conversion is deterministic, has no
 * ambient timezone input, and is directly testable.
 */

import type { ParseResult } from './brands.js';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Integer milliseconds since the Unix epoch, UTC. */
export type Instant = Brand<number, 'Instant'>;
/** A non-negative duration in milliseconds. */
export type Millis = Brand<number, 'Millis'>;

export function instant(msSinceEpoch: number): Instant {
  if (!Number.isInteger(msSinceEpoch)) {
    throw new RangeError(`instant must be integer milliseconds, received ${String(msSinceEpoch)}`);
  }
  return msSinceEpoch as Instant;
}

export function millis(value: number): Millis {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `duration must be a non-negative integer of milliseconds, received ${String(value)}`,
    );
  }
  return value as Millis;
}

const MS_PER_DAY = 86_400_000;

/** Days from 1970-01-01 to a proleptic Gregorian civil date. Howard Hinnant's algorithm. */
function daysFromCivil(y: number, m: number, d: number): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of `daysFromCivil`. */
function civilFromDays(z: number): { y: number; m: number; d: number } {
  const shifted = z + 719468;
  const era = Math.floor(shifted / 146097);
  const doe = shifted - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Parse an ISO-8601 instant.
 *
 * A timestamp without an explicit `Z` or numeric offset is rejected rather than assumed to
 * be UTC. Silently assuming a zone on evidence that decides whether money moves is exactly
 * the class of mistake this product exists to prevent.
 */
export function parseIsoInstant(input: string): ParseResult<Instant> {
  const match = ISO_RE.exec(input.trim());
  if (match === null) {
    return {
      ok: false,
      error: 'timestamp must be ISO-8601 with an explicit UTC designator or numeric offset',
    };
  }
  const [, yr, mo, dy, hh, mi, ss = '0', frac = '', zone = 'Z'] = match;
  const y = Number(yr);
  const m = Number(mo);
  const d = Number(dy);
  const hour = Number(hh);
  const minute = Number(mi);
  const second = Number(ss);

  if (m < 1 || m > 12) return { ok: false, error: `month out of range: ${m}` };
  const maxDay = m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1]!;
  if (d < 1 || d > maxDay) return { ok: false, error: `day out of range for month: ${d}` };
  if (hour > 23) return { ok: false, error: `hour out of range: ${hour}` };
  if (minute > 59) return { ok: false, error: `minute out of range: ${minute}` };
  // 60 would be a leap second; Unix time has no representation for one.
  if (second > 59) return { ok: false, error: `second out of range: ${second}` };

  const ms = Number((frac + '000').slice(0, 3));

  let offsetMinutes = 0;
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4));
    if (oh > 23 || om > 59) return { ok: false, error: `offset out of range: ${zone}` };
    offsetMinutes = sign * (oh * 60 + om);
  }

  const utcMs =
    daysFromCivil(y, m, d) * MS_PER_DAY +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1_000 +
    ms -
    offsetMinutes * 60_000;

  return { ok: true, value: utcMs as Instant };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Format as an ISO-8601 UTC instant with millisecond precision. */
export function toIso(value: Instant): string {
  const days = Math.floor(value / MS_PER_DAY);
  let rem = value - days * MS_PER_DAY;
  if (rem < 0) rem += MS_PER_DAY;
  const { y, m, d } = civilFromDays(days);
  const hour = Math.floor(rem / 3_600_000);
  const minute = Math.floor((rem % 3_600_000) / 60_000);
  const second = Math.floor((rem % 60_000) / 1_000);
  const ms = rem % 1_000;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(ms, 3)}Z`;
}

export const addMillis = (t: Instant, d: Millis): Instant => (t + d) as Instant;
export const subMillis = (t: Instant, d: Millis): Instant => (t - d) as Instant;

/** Age of an observation at `now`. Clamped at zero: a future-dated observation is age 0, never negative. */
export function ageAt(observedAt: Instant, now: Instant): Millis {
  const delta = now - observedAt;
  return (delta > 0 ? delta : 0) as Millis;
}

/**
 * True when the observation has reached its freshness limit.
 * The boundary is inclusive: at exactly the limit the evidence is already stale, because
 * ties must resolve toward blocking.
 */
export function isStale(observedAt: Instant, now: Instant, limit: Millis): boolean {
  return ageAt(observedAt, now) >= limit;
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
