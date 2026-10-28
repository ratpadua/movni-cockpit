import { forwardRef } from 'react';
import {
  Select as MantineSelect,
  MultiSelect as MantineMultiSelect,
  type SelectProps,
  type MultiSelectProps,
  type ComboboxData,
  type ComboboxItem,
  type ComboboxItemGroup,
} from '@mantine/core';

// Every dropdown in the app lists its options alphabetically. Use these instead of
// Mantine's Select / MultiSelect so the ordering is applied in one place — including
// to dropdowns added later. Portuguese-aware (accents) and number-aware, so labels
// like "2x de R$ 150,00" come before "10x de R$ 30,00". Pass `keepOrder` only where
// a list has a meaningful order that must be preserved.
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

const labelOf = (o: string | ComboboxItem): string => (typeof o === 'string' ? o : o.label ?? String(o.value));
const isGroup = (o: string | ComboboxItem | ComboboxItemGroup): o is ComboboxItemGroup =>
  typeof o === 'object' && o !== null && 'group' in o;

function sortItems<T extends string | ComboboxItem>(items: T[]): T[] {
  return [...items].sort((a, b) => collator.compare(labelOf(a), labelOf(b)));
}

// Sort a Select `data` array. Items are sorted by label; in a grouped list the groups
// keep their given order (e.g. "Sugestões" before "Abertos") and the items inside each
// group are sorted.
export function sortOptions(data: ComboboxData | undefined): ComboboxData | undefined {
  if (!data) return data;
  const arr = data as Array<string | ComboboxItem | ComboboxItemGroup>;
  if (arr.some(isGroup)) {
    return arr.map((o) => (isGroup(o) ? { ...o, items: sortItems(o.items) } : o)) as ComboboxData;
  }
  return sortItems(arr as Array<string | ComboboxItem>) as ComboboxData;
}

type Sortable = { keepOrder?: boolean };

export const Select = forwardRef<HTMLInputElement, SelectProps & Sortable>(function Select(
  { data, keepOrder, ...rest },
  ref
) {
  return <MantineSelect ref={ref} data={keepOrder ? data : sortOptions(data)} {...rest} />;
});

export const MultiSelect = forwardRef<HTMLInputElement, MultiSelectProps & Sortable>(function MultiSelect(
  { data, keepOrder, ...rest },
  ref
) {
  return <MantineMultiSelect ref={ref} data={keepOrder ? data : sortOptions(data)} {...rest} />;
});
