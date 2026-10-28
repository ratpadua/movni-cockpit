import { useEffect } from 'react';
import { Stack, Group, Text, Table, Alert } from '@mantine/core';
import { Select } from './Select';
import { DateInput } from '@mantine/dates';
import { IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { api, AppSettings } from '../api/client';
import {
  addMonthsIso,
  monthlyDueDates,
  splitAmount,
  maxInstallmentsFor,
  todayIso,
  isoToDate,
  dateToIso,
} from '../lib/dates';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export interface InstallmentValue {
  count: number;
  dueDates: string[];
}

// Installment + due-date planner. `amount` is the total after regular discounts
// (before the single-installment cash discount). When `cashDiscount` is set, a
// single installment applies an extra 5%.
export default function InstallmentPlanner({
  amount,
  cashDiscount,
  value,
  onChange,
}: {
  amount: number;
  cashDiscount?: boolean;
  value: InstallmentValue;
  onChange: (v: InstallmentValue) => void;
}) {
  // Smallest allowed installment, configurable in Configurações (R$150 by default).
  const { data: settings } = useQuery({ queryKey: ['/settings'], queryFn: () => api.get<AppSettings>('/settings') });
  const minValue = settings?.minInstallmentValue ?? 150;
  const max = maxInstallmentsFor(amount, minValue);
  const count = Math.min(Math.max(1, value.count || 1), max);
  const effectiveTotal = cashDiscount && count === 1 ? amount * 0.95 : amount;
  const amounts = splitAmount(effectiveTotal, count);

  // Keep count within [1, max] and dueDates length aligned to count.
  useEffect(() => {
    const dd = value.dueDates.slice(0, count);
    if (dd.length < count) {
      const first = dd[0] ?? value.dueDates[0] ?? todayIso();
      for (let i = dd.length; i < count; i++) dd[i] = addMonthsIso(first, i);
    }
    if (value.count !== count || dd.length !== value.dueDates.length) {
      onChange({ count, dueDates: dd });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, max]);

  const setCount = (n: number | string | null) => {
    const c = Math.min(Math.max(1, Number(n) || 1), max);
    const first = value.dueDates[0] ?? todayIso();
    const dd = Array.from({ length: c }, (_, i) => value.dueDates[i] ?? addMonthsIso(first, i));
    onChange({ count: c, dueDates: dd });
  };

  // Each option shows the count and the per-installment amount, e.g. "5 (R$ 168,98)".
  const countOptions = Array.from({ length: max }, (_, i) => {
    const n = i + 1;
    const eff = cashDiscount && n === 1 ? amount * 0.95 : amount;
    return { value: String(n), label: `${n} (${brl(splitAmount(eff, n)[0])})` };
  });
  const setFirst = (iso: string) => onChange({ count, dueDates: monthlyDueDates(iso || todayIso(), count) });
  const setOne = (i: number, iso: string) => {
    const dd = value.dueDates.slice();
    dd[i] = iso;
    onChange({ count, dueDates: dd });
  };

  return (
    <Stack gap="xs">
      <Group grow align="flex-end">
        <Select
          label={`Parcelas (máx. ${max})`}
          description={`Mínimo de ${brl(minValue)} por parcela`}
          data={countOptions}
          value={String(count)}
          onChange={setCount}
          allowDeselect={false}
          searchable
          comboboxProps={{ withinPortal: true }}
        />
        <DateInput
          label="Primeiro vencimento"
          valueFormat="DD/MM/YYYY"
          placeholder="dd/mm/aaaa"
          value={isoToDate(value.dueDates[0] ?? '')}
          onChange={(d) => setFirst(dateToIso(d))}
        />
      </Group>

      {cashDiscount && count === 1 && (
        <Alert icon={<IconInfoCircle size={16} />} color="teal" variant="light" p="xs">
          Pagamento à vista (1 parcela): desconto adicional de 5% aplicado.
        </Alert>
      )}

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Parcela</Table.Th>
            <Table.Th>Vencimento</Table.Th>
            <Table.Th ta="right">Valor</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {amounts.map((amt, i) => (
            <Table.Tr key={i}>
              <Table.Td>
                {i + 1}/{count}
              </Table.Td>
              <Table.Td>
                <DateInput
                  size="xs"
                  valueFormat="DD/MM/YYYY"
                  placeholder="dd/mm/aaaa"
                  value={isoToDate(value.dueDates[i] ?? '')}
                  onChange={(d) => setOne(i, dateToIso(d))}
                />
              </Table.Td>
              <Table.Td ta="right">{brl(amt)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Group justify="flex-end">
        <Text fw={700}>Total: {brl(effectiveTotal)}</Text>
      </Group>
    </Stack>
  );
}
