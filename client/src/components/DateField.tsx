import { DateInput, DateInputProps } from '@mantine/dates';
import { isoToDate, dateToIso } from '../lib/dates';

// A Brazilian-format (dd/mm/aaaa) date picker that reads and writes plain
// yyyy-mm-dd strings — a drop-in replacement for <TextInput type="date">, so
// every date picked in the app uses the same format.
type Props = Omit<DateInputProps, 'value' | 'onChange'> & {
  value: string; // yyyy-mm-dd, or '' when empty
  onChange: (iso: string) => void;
};

export default function DateField({ value, onChange, ...rest }: Props) {
  return (
    <DateInput
      valueFormat="DD/MM/YYYY"
      placeholder="dd/mm/aaaa"
      value={isoToDate(value)}
      onChange={(d) => onChange(dateToIso(d as Date | null))}
      {...rest}
    />
  );
}
