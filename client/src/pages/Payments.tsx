import { useMemo, useState } from 'react';
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
  Modal,
} from '@mantine/core';
import { MultiSelect, Select } from '../components/Select';
import { IconPlus, IconEdit, IconTrash, IconCheck, IconFilter, IconFileText, IconChevronLeft, IconChevronRight, IconRepeat } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, Payment, Customer, ContractSummary, Category } from '../api/client';
import { todayIso, formatBr, monthBoundsIso, isoToDate } from '../lib/dates';
import DateField from '../components/DateField';
import PaymentFormModal from '../components/PaymentFormModal';
import RecurrenceScopeModal, { type SeriesScope } from '../components/RecurrenceScopeModal';
import { generateReceipt } from '../lib/download';
import { paymentSituation } from '../lib/paymentStatus';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Every Situação a row can show (entradas and saídas); option values are the
// exact badge labels, so the filter matches what the table displays.
const SITUATION_OPTIONS = ['Aberto', 'A pagar', 'Atrasado', 'Recebido', 'Enviado', 'Pago'];

export default function Payments() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['/payments'] });

  const { data: payments = [] } = useQuery({ queryKey: ['/payments'], queryFn: () => api.get<Payment[]>('/payments') });
  const { data: customers = [] } = useQuery({ queryKey: ['/customers'], queryFn: () => api.get<Customer[]>('/customers') });
  const { data: contracts = [] } = useQuery({ queryKey: ['/contracts'], queryFn: () => api.get<ContractSummary[]>('/contracts') });
  const { data: categories = [] } = useQuery({ queryKey: ['/categories'], queryFn: () => api.get<Category[]>('/categories') });

  const err = (e: Error) => notifications.show({ message: e.message, color: 'red' });

  // ---- filters ----
  const [fFlow, setFFlow] = useState<string | null>(null);
  // Multi-select filters: an empty list means "no filter"; several values match any of them.
  const [fCustomer, setFCustomer] = useState<string[]>([]);
  const [fContract, setFContract] = useState<string[]>([]);
  const [fCategory, setFCategory] = useState<string[]>([]);
  // Situação: one filter covering entradas and saídas; its values are the exact
  // badge labels shown in the table (see paymentSituation).
  const [fSituation, setFSituation] = useState<string[]>([]);
  // The cash-flow view defaults to the current month; the From/To pickers (or the
  // month arrows) widen or move the period.
  const [fFrom, setFFrom] = useState(() => monthBoundsIso().from);
  const [fTo, setFTo] = useState(() => monthBoundsIso().to);
  const setMonth = (offset: number, base?: string | null) => {
    const { from, to } = monthBoundsIso(base, offset);
    setFFrom(from);
    setFTo(to);
  };
  const clearFilters = () => {
    setFFlow(null); setFCustomer([]); setFContract([]); setFCategory([]); setFSituation([]);
    setMonth(0); // back to the default: current month
  };

  // Label for the period: the month name when the range is exactly one calendar
  // month, otherwise a custom-range description.
  const periodLabel = useMemo(() => {
    if (!fFrom && !fTo) return 'Todo o período';
    const { from, to } = monthBoundsIso(fFrom || fTo);
    if (fFrom === from && fTo === to) {
      const d = isoToDate(fFrom)!;
      const name = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return `${fFrom ? formatBr(fFrom) : '…'} a ${fTo ? formatBr(fTo) : '…'}`;
  }, [fFrom, fTo]);

  // Filtered, then ordered by due date (earliest first; undated last, ties by id).
  const filtered = useMemo(
    () =>
      payments
        .filter((p) => {
          if (fFlow && p.flow !== fFlow) return false;
          if (fCustomer.length && !fCustomer.includes(String(p.customerId ?? ''))) return false;
          if (fContract.length && !fContract.includes(String(p.contractId ?? ''))) return false;
          if (fCategory.length && !fCategory.includes(String(p.categoryId ?? ''))) return false;
          // Matches the Situação badge exactly (Atrasado is derived, not stored).
          if (fSituation.length && !fSituation.includes(paymentSituation(p).label)) return false;
          if (fFrom && (!p.dueDate || p.dueDate < fFrom)) return false;
          if (fTo && (!p.dueDate || p.dueDate > fTo)) return false;
          return true;
        })
        .sort((a, b) => {
          if (a.dueDate !== b.dueDate) {
            if (!a.dueDate) return 1;
            if (!b.dueDate) return -1;
            return a.dueDate.localeCompare(b.dueDate);
          }
          return a.id - b.id;
        }),
    [payments, fFlow, fCustomer, fContract, fCategory, fSituation, fFrom, fTo]
  );

  const customerOptions = customers.map((c) => ({ value: String(c.id), label: c.nickname || c.name }));
  const contractOptions = contracts.map((c) => ({ value: String(c.id), label: `${c.number ?? `#${c.id}`}${c.customerName ? ` — ${c.customerName}` : ''}` }));
  const categoryOptions = categories.map((c) => ({ value: String(c.id), label: c.name }));

  // ---- add / edit ----
  // The form itself lives in the shared PaymentFormModal (also used on the contract page).
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Payment | null>(null);
  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (p: Payment) => {
    setEditing(p);
    setFormOpen(true);
  };
  // `scope` only matters for a recurring payment: also delete its following / all open
  // series payments (see RecurrenceScopeModal).
  const remove = useMutation({
    mutationFn: ({ id, scope }: { id: number; scope?: SeriesScope }) =>
      api.del(`/payments/${id}${scope && scope !== 'one' ? `?scope=${scope}` : ''}`),
    onSuccess: () => {
      invalidate();
      setDeleteFor(null);
    },
    onError: err,
  });
  // A recurring payment asks which payments of its series to delete; others use a plain confirm.
  const [deleteFor, setDeleteFor] = useState<Payment | null>(null);
  const askDelete = (p: Payment) => {
    if (p.recurrenceId) setDeleteFor(p);
    else if (confirm('Excluir este pagamento?')) remove.mutate({ id: p.id });
  };

  // ---- mark received ----
  const [recvFor, setRecvFor] = useState<Payment | null>(null);
  const [recvDate, setRecvDate] = useState('');
  const markReceived = useMutation({
    mutationFn: () => api.put(`/payments/${recvFor!.id}`, { receiptStatus: 'received', receivedDate: recvDate || todayIso() }),
    onSuccess: () => {
      invalidate();
      setRecvFor(null);
      notifications.show({ message: 'Marcado como recebido', color: 'green' });
    },
    onError: err,
  });

  const receiptAction = (p: Payment) => {
    if (p.flow !== 'in') return null;
    if (p.receiptStatus === 'open') {
      return (
        <Button size="compact-xs" variant="light" leftSection={<IconCheck size={14} />} onClick={() => { setRecvFor(p); setRecvDate(todayIso()); }}>
          Marcar recebido
        </Button>
      );
    }
    return (
      <Group gap={4} wrap="nowrap">
        <Button size="compact-xs" variant="light" leftSection={<IconFileText size={14} />} onClick={async () => { if (await generateReceipt(p.id, 'docx')) invalidate(); }}>
          Baixar
        </Button>
        <Button size="compact-xs" variant="light" onClick={async () => { if (await generateReceipt(p.id, 'pdf')) invalidate(); }}>
          PDF
        </Button>
      </Group>
    );
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Fluxo de Caixa</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={openNew}>
          Novo pagamento
        </Button>
      </Group>

      {/* period navigator: month by month; the date pickers below allow longer periods */}
      <Group gap="xs">
        <ActionIcon variant="default" size="lg" aria-label="Mês anterior" onClick={() => setMonth(-1, fFrom || fTo)}>
          <IconChevronLeft size={18} />
        </ActionIcon>
        <Text fw={600} miw={190} ta="center">
          {periodLabel}
        </Text>
        <ActionIcon variant="default" size="lg" aria-label="Próximo mês" onClick={() => setMonth(1, fFrom || fTo)}>
          <IconChevronRight size={18} />
        </ActionIcon>
        <Button variant="light" size="xs" onClick={() => setMonth(0)}>
          Mês atual
        </Button>
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          onClick={() => {
            setFFrom('');
            setFTo('');
          }}
        >
          Todo o período
        </Button>
      </Group>

      {/* filters */}
      <Paper withBorder radius="md" p="sm">
        <Group align="flex-end" wrap="wrap">
          <Select label="Tipo" placeholder="Todos" w={130} clearable data={[{ value: 'in', label: 'Entrada' }, { value: 'out', label: 'Saída' }]} value={fFlow} onChange={setFFlow} />
          <MultiSelect label="Cliente" placeholder={fCustomer.length ? undefined : 'Todos'} w={200} clearable searchable hidePickedOptions data={customerOptions} value={fCustomer} onChange={setFCustomer} />
          <MultiSelect label="Contrato" placeholder={fContract.length ? undefined : 'Todos'} w={200} clearable searchable hidePickedOptions data={contractOptions} value={fContract} onChange={setFContract} />
          <MultiSelect label="Categoria" placeholder={fCategory.length ? undefined : 'Todas'} w={200} clearable searchable hidePickedOptions data={categoryOptions} value={fCategory} onChange={setFCategory} />
          <MultiSelect label="Situação" placeholder={fSituation.length ? undefined : 'Todas'} w={200} clearable hidePickedOptions data={SITUATION_OPTIONS} value={fSituation} onChange={setFSituation} />
          <DateField label="Venc. de" w={150} clearable value={fFrom} onChange={setFFrom} />
          <DateField label="Venc. até" w={150} clearable value={fTo} onChange={setFTo} />
          <Button variant="subtle" color="gray" leftSection={<IconFilter size={14} />} onClick={clearFilters}>
            Limpar
          </Button>
          <Text size="sm" c="dimmed">
            {filtered.length} de {payments.length}
          </Text>
        </Group>
      </Paper>

      <Paper withBorder radius="md" style={{ overflowX: 'auto' }}>
        <Table highlightOnHover miw={850}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Cliente</Table.Th>
              <Table.Th>Contrato</Table.Th>
              <Table.Th>Descrição</Table.Th>
              <Table.Th ta="right">Valor</Table.Th>
              <Table.Th>Situação</Table.Th>
              <Table.Th>Vencimento</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {filtered.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <Text c="dimmed">Nenhum pagamento.</Text>
                </Table.Td>
              </Table.Tr>
            )}
            {filtered.map((p) => (
              // Entrada rows are tinted green, saída rows red (replaces the Tipo column).
              <Table.Tr
                key={p.id}
                title={p.flow === 'in' ? 'Entrada' : 'Saída'}
                style={{ backgroundColor: p.flow === 'in' ? 'var(--mantine-color-green-light)' : 'var(--mantine-color-red-light)' }}
              >
                <Table.Td>{p.customerNickname || p.customerName || '—'}</Table.Td>
                <Table.Td>{p.contractNumber ?? '—'}</Table.Td>
                <Table.Td>
                  {p.description}
                  {p.categoryName && (
                    <Text span size="xs" c="dimmed">
                      {' '}· {p.categoryName}
                    </Text>
                  )}
                  {/* Payments created together by one recurrence (e.g. a monthly fee). */}
                  {p.recurrenceId && (
                    <Badge ml={6} size="sm" variant="light" color="grape" leftSection={<IconRepeat size={11} />}>
                      Recorrente
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td ta="right" fw={600} c={p.flow === 'in' ? 'green.8' : 'red.8'}>
                  {brl(Number(p.amount))}
                </Table.Td>
                <Table.Td>
                  {(() => {
                    const s = paymentSituation(p);
                    return (
                      <Badge color={s.color} variant="light">
                        {s.label}
                      </Badge>
                    );
                  })()}
                </Table.Td>
                <Table.Td>{formatBr(p.dueDate)}</Table.Td>
                <Table.Td>
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    {receiptAction(p)}
                    <ActionIcon variant="subtle" title="Editar" onClick={() => openEdit(p)}>
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon variant="subtle" color="red" title="Excluir" onClick={() => askDelete(p)}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>

      {/* add / edit modal */}
      <PaymentFormModal opened={formOpen} payment={editing} onClose={() => setFormOpen(false)} />

      {/* which payments of a recurring series to delete */}
      <RecurrenceScopeModal
        opened={deleteFor != null}
        payment={deleteFor}
        mode="delete"
        loading={remove.isPending}
        onClose={() => setDeleteFor(null)}
        onConfirm={(scope) => deleteFor && remove.mutate({ id: deleteFor.id, scope })}
      />

      {/* mark received modal */}
      <Modal opened={recvFor != null} onClose={() => setRecvFor(null)} title="Marcar recibo como recebido">
        <Stack>
          <Text size="sm">
            {recvFor?.description} — {recvFor ? brl(Number(recvFor.amount)) : ''}
          </Text>
          <DateField label="Data de recebimento" description="Data que sai no recibo." value={recvDate} onChange={setRecvDate} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRecvFor(null)}>
              Cancelar
            </Button>
            <Button loading={markReceived.isPending} onClick={() => markReceived.mutate()}>
              Confirmar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
