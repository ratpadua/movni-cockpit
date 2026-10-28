// Small date/money helpers for the installment planner. All dates are handled
// as local yyyy-mm-dd strings (matching the <input type="date"> value format).

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayIso(): string {
  return toIso(new Date());
}

// First and last day (yyyy-mm-dd) of the month containing `iso` (default: today),
// optionally shifted by `offset` months.
export function monthBoundsIso(iso?: string | null, offset = 0): { from: string; to: string } {
  const base = isoToDate(iso || todayIso()) ?? new Date();
  const first = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { from: toIso(first), to: toIso(last) };
}

// Format a yyyy-mm-dd string as Brazilian dd/MM/yyyy for display. Returns '—'
// for empty values. Pure string work — no timezone shifts.
export function formatBr(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

// Bridge between our yyyy-mm-dd strings and Mantine's <DateInput> Date values.
export function isoToDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function dateToIso(d: Date | null): string {
  return d ? toIso(d) : '';
}

// Add n months keeping the same day-of-month (clamped to the month's last day).
export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const target = new Date(y, m - 1 + n, 1);
  const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, daysInMonth));
  return toIso(target);
}

// Add n business days (skipping Saturdays and Sundays).
export function addBusinessDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  let added = 0;
  while (added < n) {
    date.setDate(date.getDate() + 1);
    const wd = date.getDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return toIso(date);
}

// Build `count` monthly due dates starting at `first` (same day each month).
export function monthlyDueDates(first: string, count: number): string[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => addMonthsIso(first, i));
}

// ---- recurring payments ----
// Mirrors server/src/lib/recurrence.ts — keep the two in sync (the form previews the
// number of payments with this; the server creates them).
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: 'Diária',
  weekly: 'Semanal',
  monthly: 'Mensal',
  yearly: 'Anual',
};
export const MAX_OCCURRENCES = 1000;

const pad2 = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12

// k-th due date, counted from the FIRST date (no drift: the 31st goes to the last day
// of short months and back to the 31st; Feb 29 yearly becomes Feb 28).
function occurrence(first: string, freq: Frequency, k: number): string {
  const [y, m, d] = first.split('-').map(Number);
  if (freq === 'daily' || freq === 'weekly') {
    const t = new Date(Date.UTC(y, m - 1, d + k * (freq === 'daily' ? 1 : 7)));
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }
  if (freq === 'monthly') {
    const idx = m - 1 + k;
    const yy = y + Math.floor(idx / 12);
    const mm = (idx % 12) + 1;
    return `${yy}-${pad2(mm)}-${pad2(Math.min(d, daysInMonth(yy, mm)))}`;
  }
  const yy = y + k;
  return `${yy}-${pad2(m)}-${pad2(Math.min(d, daysInMonth(yy, m)))}`;
}

// Every due date from `first` through `until` (inclusive); stops after `limit` dates.
export function recurrenceDates(first: string, freq: Frequency, until: string, limit = MAX_OCCURRENCES + 1): string[] {
  const out: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return out;
  for (let k = 0; out.length < limit; k++) {
    const d = occurrence(first, freq, k);
    if (d > until) break;
    out.push(d);
  }
  return out;
}

// Split a total into `count` equal installments (cents-exact; remainder on last).
export function splitAmount(total: number, count: number): number[] {
  const n = Math.max(1, count);
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const arr = Array.from({ length: n }, () => base);
  arr[n - 1] += cents - base * n;
  return arr.map((c) => c / 100);
}

// Max installments so none is below `minValue` (the configurable minimum installment,
// R$150 by default); at least 1.
export const maxInstallmentsFor = (total: number, minValue = 150) =>
  Math.max(1, Math.floor(total / (minValue > 0 ? minValue : 150)));
