import { useState } from 'react';
import {
  Stack,
  Title,
  Group,
  Paper,
  Table,
  Text,
  Button,
  SimpleGrid,
  Badge,
} from '@mantine/core';
import { Select } from '../components/Select';
import { IconFilter } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { api, Category, ReportEntry } from '../api/client';
import DateField from '../components/DateField';
import { formatBr } from '../lib/dates';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface Summary {
  totalIn: number;
  totalOut: number;
  net: number;
  count: number;
}

export default function Reports() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [flow, setFlow] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [applied, setApplied] = useState(0); // bump to refetch

  const { data: categories = [] } = useQuery({
    queryKey: ['/categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });

  const qs = () => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (flow) p.set('flow', flow);
    if (categoryId) p.set('categoryId', categoryId);
    return p.toString();
  };

  const { data: rows = [] } = useQuery({
    queryKey: ['/reports/entries', applied],
    queryFn: () => api.get<ReportEntry[]>(`/reports/entries?${qs()}`),
  });
  const { data: summary } = useQuery({
    queryKey: ['/reports/summary', applied],
    queryFn: () => {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      return api.get<Summary>(`/reports/summary?${p.toString()}`);
    },
  });

  const categoryOptions = categories.map((c) => ({ value: String(c.id), label: c.name }));

  return (
    <Stack>
      <Title order={2}>Relatórios</Title>

      <Paper withBorder radius="md" p="md">
        <Group align="flex-end" wrap="wrap">
          <DateField label="De" clearable value={from} onChange={setFrom} />
          <DateField label="Até" clearable value={to} onChange={setTo} />
          <Select
            label="Tipo"
            placeholder="Todos"
            data={[
              { value: 'in', label: 'Receita' },
              { value: 'out', label: 'Custo' },
            ]}
            value={flow}
            onChange={setFlow}
            clearable
            w={140}
          />
          <Select
            label="Categoria"
            placeholder="Todas"
            data={categoryOptions}
            value={categoryId}
            onChange={setCategoryId}
            searchable
            clearable
            w={200}
          />
          <Button leftSection={<IconFilter size={16} />} onClick={() => setApplied((n) => n + 1)}>
            Filtrar
          </Button>
        </Group>
      </Paper>

      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Paper withBorder p="md" radius="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Receitas
          </Text>
          <Text size="xl" fw={700} c="green">
            {brl(summary?.totalIn ?? 0)}
          </Text>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Custos
          </Text>
          <Text size="xl" fw={700} c="red">
            {brl(Math.abs(summary?.totalOut ?? 0))}
          </Text>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Resultado (lucro)
          </Text>
          <Text size="xl" fw={700} c={(summary?.net ?? 0) >= 0 ? 'green' : 'red'}>
            {brl(summary?.net ?? 0)}
          </Text>
        </Paper>
      </SimpleGrid>

      <Paper withBorder radius="md" style={{ overflowX: 'auto' }}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Data</Table.Th>
              <Table.Th>Descrição</Table.Th>
              <Table.Th>Cliente</Table.Th>
              <Table.Th>Categoria</Table.Th>
              <Table.Th>Tipo</Table.Th>
              <Table.Th ta="right">Valor</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={6}>
                  <Text c="dimmed">Nenhum lançamento no filtro.</Text>
                </Table.Td>
              </Table.Tr>
            )}
            {rows.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td>{formatBr(r.date)}</Table.Td>
                <Table.Td>{r.description ?? '—'}</Table.Td>
                <Table.Td>{r.customerNickname || r.customerName || '—'}</Table.Td>
                <Table.Td>{r.categoryName ?? '—'}</Table.Td>
                <Table.Td>
                  <Badge color={r.flow === 'in' ? 'green' : 'red'} variant="light">
                    {r.flow === 'in' ? 'Receita' : 'Custo'}
                  </Badge>
                </Table.Td>
                <Table.Td ta="right">{brl(Number(r.amount))}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  );
}
