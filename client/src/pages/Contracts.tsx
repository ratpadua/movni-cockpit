import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Stack,
  Title,
  Group,
  Button,
  Paper,
  Table,
  Text,
  Badge,
  ActionIcon,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { Select } from '../components/Select';
import {
  IconPlus,
  IconEdit,
  IconTrash,
  IconExternalLink,
  IconSearch,
  IconSortAscendingLetters,
  IconSortDescendingLetters,
} from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, ContractSummary, ContractStatus, AppSettings } from '../api/client';
import ContractFormModal from '../components/ContractFormModal';
import { CONTRACT_STATUSES, STATUS_LABELS, STATUS_COLORS, isOverdue, statusDeadline } from '../lib/status';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const typeLabel = (t: string) => (t === 'invoice' ? 'Fatura' : 'Contrato');
const norm = (v: any) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

type SortKey = 'customerName' | 'title' | 'number' | 'createdAt' | 'total';
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'customerName', label: 'Cliente' },
  { value: 'title', label: 'Título' },
  { value: 'number', label: 'Número' },
  { value: 'createdAt', label: 'Criado' },
  { value: 'total', label: 'Total' },
];

export default function Contracts() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: contracts = [] } = useQuery({
    queryKey: ['/contracts'],
    queryFn: () => api.get<ContractSummary[]>('/contracts'),
  });
  const { data: settings } = useQuery({ queryKey: ['/settings'], queryFn: () => api.get<AppSettings>('/settings') });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [fStatus, setFStatus] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('number');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const visible = useMemo(() => {
    let list = contracts;
    if (search.trim()) {
      const q = norm(search);
      list = list.filter((c) =>
        [c.number, c.customerName, c.title, typeLabel(c.type)].some((x) => norm(x).includes(q))
      );
    }
    if (fStatus) list = list.filter((c) => c.type === 'contract' && c.status === fStatus);
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      let r: number;
      if (sortKey === 'total') r = Number(a.total) - Number(b.total);
      else if (sortKey === 'createdAt') r = String(a.createdAt).localeCompare(String(b.createdAt));
      else
        r = String((a as any)[sortKey] ?? '').localeCompare(String((b as any)[sortKey] ?? ''), 'pt-BR', {
          numeric: true,
          sensitivity: 'base',
        });
      return r * dir;
    });
  }, [contracts, search, fStatus, sortKey, sortDir]);

  const openCreate = () => {
    setEditingId(null);
    setFormOpen(true);
  };
  const openEdit = (id: number) => {
    setEditingId(id);
    setFormOpen(true);
  };

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/contracts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/contracts'] }),
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={2}>Contratos</Title>
          <Text size="sm" c="dimmed">
            Vincula um cliente a um serviço do catálogo e gera o documento.
          </Text>
        </div>
        <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>
          Novo contrato
        </Button>
      </Group>

      <Paper withBorder radius="md" p="sm">
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="Buscar"
            placeholder="Cliente, número, título…"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={240}
          />
          <Select
            label="Status"
            placeholder="Todos"
            data={CONTRACT_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
            keepOrder // workflow order (Aguardando pagamento → … → Finalizado), not alphabetical
            value={fStatus}
            onChange={setFStatus}
            clearable
            searchable
            w={190}
          />
          <Group align="flex-end" gap={4}>
            <Select
              label="Ordenar por"
              data={SORT_OPTIONS}
              value={sortKey}
              onChange={(v) => v && setSortKey(v as SortKey)}
              w={170}
            />
            <ActionIcon
              variant="default"
              size="lg"
              title={sortDir === 'asc' ? 'A → Z' : 'Z → A'}
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            >
              {sortDir === 'asc' ? (
                <IconSortAscendingLetters size={18} />
              ) : (
                <IconSortDescendingLetters size={18} />
              )}
            </ActionIcon>
          </Group>
          <Text size="sm" c="dimmed">
            {visible.length} de {contracts.length}
          </Text>
        </Group>
      </Paper>

      <Paper withBorder radius="md">
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Número</Table.Th>
              <Table.Th>Cliente</Table.Th>
              <Table.Th>Tipo</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Título</Table.Th>
              <Table.Th ta="right">Total</Table.Th>
              <Table.Th>Criado</Table.Th>
              <Table.Th style={{ width: 130 }} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visible.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={8}>
                  <Text c="dimmed">
                    {contracts.length === 0 ? 'Nenhum contrato ainda.' : 'Nenhum contrato encontrado.'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {visible.map((c) => (
              <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${c.id}`)}>
                <Table.Td fw={600}>{c.number ?? `#${c.id}`}</Table.Td>
                <Table.Td>{c.customerName ?? '—'}</Table.Td>
                <Table.Td>
                  <Badge variant="light" color={c.type === 'invoice' ? 'blue' : 'teal'}>
                    {typeLabel(c.type)}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {c.type === 'contract' ? (
                    (() => {
                      const overdue = isOverdue(c.status, c.statusChangedAt, settings);
                      const dl = statusDeadline(c.status, c.statusChangedAt, settings);
                      return (
                        <Tooltip label={dl ? `Prazo: ${dl.toLocaleDateString('pt-BR')}` : ''} disabled={!dl}>
                          <Badge variant="light" color={overdue ? 'red' : STATUS_COLORS[c.status as ContractStatus]}>
                            {STATUS_LABELS[c.status as ContractStatus]}
                            {overdue ? ' · atrasado' : ''}
                          </Badge>
                        </Tooltip>
                      );
                    })()
                  ) : (
                    <Text size="xs" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{c.title ?? '—'}</Table.Td>
                <Table.Td ta="right">{brl(Number(c.total))}</Table.Td>
                <Table.Td>{new Date(c.createdAt).toLocaleDateString('pt-BR')}</Table.Td>
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  <Group gap={2} justify="flex-end" wrap="nowrap">
                    <ActionIcon variant="subtle" title="Abrir" onClick={() => navigate(`/contracts/${c.id}`)}>
                      <IconExternalLink size={16} />
                    </ActionIcon>
                    <ActionIcon variant="subtle" title="Editar" onClick={() => openEdit(c.id)}>
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      title="Excluir"
                      onClick={() => {
                        if (confirm('Excluir este contrato?')) remove.mutate(c.id);
                      }}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>

      <ContractFormModal
        opened={formOpen}
        editingId={editingId}
        onClose={() => setFormOpen(false)}
        onSaved={(id, type) => {
          if (!editingId && type === 'invoice' && id) navigate(`/contracts/${id}`);
        }}
      />
    </Stack>
  );
}
