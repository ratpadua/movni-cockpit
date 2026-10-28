// Due dates of a recurring payment. Mirrors `recurrenceDates` in client/src/lib/dates.ts
// (the form previews the count with it) — keep the two in sync.

export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

// A recurrence can't create an unbounded number of payments.
export const MAX_OCCURRENCES = 1000;

const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
// Days in month `m` (1-12) of year `y`.
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// The k-th occurrence (k = 0 is the first date), always counted from the FIRST date
// so a monthly payment on the 31st falls on the last day of shorter months and
// returns to the 31st afterwards (no drift); Feb 29 yearly falls on Feb 28.
function occurrence(first: string, freq: Frequency, k: number): string {
  const [y, m, d] = first.split('-').map(Number);
  if (freq === 'daily' || freq === 'weekly') {
    const t = new Date(Date.UTC(y, m - 1, d + k * (freq === 'daily' ? 1 : 7)));
    return toIso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  if (freq === 'monthly') {
    const idx = m - 1 + k;
    const yy = y + Math.floor(idx / 12);
    const mm = (idx % 12) + 1;
    return toIso(yy, mm, Math.min(d, daysInMonth(yy, mm)));
  }
  const yy = y + k;
  return toIso(yy, m, Math.min(d, daysInMonth(yy, m)));
}

// Every due date from `first` up to and including `until` (yyyy-mm-dd). Stops after
// `limit` dates so a huge range can't run away; callers check against MAX_OCCURRENCES.
export function recurrenceDates(first: string, freq: Frequency, until: string, limit = MAX_OCCURRENCES + 1): string[] {
  const out: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return out;
  for (let k = 0; out.length < limit; k++) {
    const d = occurrence(first, freq, k);
    if (d > until) break; // ISO dates compare correctly as strings
    out.push(d);
  }
  return out;
}
