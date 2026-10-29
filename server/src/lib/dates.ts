// Today's date as a LOCAL yyyy-mm-dd string. (`new Date().toISOString()` is UTC and
// returns tomorrow's date in the evening in Brazil.)
export function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
