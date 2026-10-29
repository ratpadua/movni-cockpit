import { DateInput, DateInputProps } from '@mantine/dates';
import { isoToDate, dateToIso } from '../lib/dates';

// A Brazilian-format (dd/mm/aaaa) date picker that reads and writes plain
// yyyy-mm-dd strings — a drop-in replacement for <TextInput type="date">, so
// every date picked in the app uses the same format.
type Props = Omit<DateInputProps, 'value' | 'onChange'> & {
  value: string; // yyyy-mm-dd, or '' when empty
  onChange: (iso: string) => void;
};

// Strict dd/MM/yyyy (also d/M/yyyy) parser for typed text. Mantine's default parser falls
// back to `new Date(text)` (US month-first) when dayjs' customParseFormat is not loaded,
// so we never rely on it. Impossible dates (31/02) and anything else return null, which
// DateInput ignores (the previous value is kept) instead of silently picking another date.
export function parseBrDate(text: string): Date | null {
  const m = /^\s*(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\s*$/.exec(text);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (y < 1000) return null;
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

export default function DateField({ value, onChange, ...rest }: Props) {
  return (
    <DateInput
      valueFormat="DD/MM/YYYY"
      dateParser={parseBrDate}
      placeholder="dd/mm/aaaa"
      value={isoToDate(value)}
      onChange={(d) => onChange(dateToIso(d as Date | null))}
      {...rest}
    />
  );
}
