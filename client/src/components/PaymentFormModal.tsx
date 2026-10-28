import { useEffect, useState } from 'react';
import { Modal, Stack, Group, Button, TextInput, NumberInput, Switch, Alert, Text } from '@mantine/core';
import { Select } from './Select';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, Payment, Customer, ContractSummary, Category } from '../api/client';
import { todayIso, recurrenceDates, FREQUENCY_LABELS, MAX_OCCURRENCES, type Frequency } from '../lib/dates';
import DateField from './DateField';
import RecurrenceScopeModal, { type SeriesScope } from './RecurrenceScopeModal';

const FREQUENCY_OPTIONS = (Object.keys(FREQUENCY_LABELS) as Frequency[]).map((value) => ({
  value,
  label: FREQUENCY_LABELS[value],
}));
// Above this many payments the form warns before creating them.
const MANY_OCCURRENCES = 366;

type Flow = 'in' | 'out';

// Situação options per direction. Entrada uses the receipt lifecycle, saída the
// paid/unpaid status. "Atrasado" is derived from the due date, so it isn't here.
const SITUATIONS: Record<Flow, { value: string; label: string }[]> = {
  in: [
    { value: 'open', label: 'Aberto' },
    { value: 'received', label: 'Recebido' },
    { value: 'sent', label: 'Enviado' },
  ],
  out: [
    { value: 'upcoming', label: 'A pagar' },
    { value: 'done', label: 'Pago' },
  ],
};
const DEFAULT_SITUATION: Record<Flow, string> = { in: 'open', out: 'upcoming' };
const isSettled = (flow: Flow, situation: string) => (flow === 'in' ? situation !== 'open' : situation === 'done');

interface FormState {
  flow: Flow;
  situation: string;
  amount: number | string;
  description: string;
  dueDate: string;
  settleDate: string; // received (entrada) / paid (saída) date
  customerId: string | null;
  contractId: string | null;
  categoryId: string | null;
  // Recurrence (new payments only): creates one payment per date up to `until`.
  recurring: boolean;
  frequency: Frequency;
  until: string;
}

const blank = (): FormState => ({
  flow: 'out',
  situation: DEFAULT_SITUATION.out,
  amount: 0,
  description: '',
  dueDate: todayIso(),
  settleDate: '',
  customerId: null,
  contractId: null,
  categoryId: null,
  recurring: false,
  frequency: 'monthly',
  until: '',
});

const fromPayment = (p: Payment): FormState => ({
  flow: p.flow,
  situation: p.flow === 'in' ? p.receiptStatus : p.status,
  amount: Number(p.amount),
  description: p.description,
  dueDate: p.dueDate ?? '',
  settleDate: (p.flow === 'in' ? p.receivedDate : p.paidDate) ?? '',
  customerId: p.customerId != null ? String(p.customerId) : null,
  contractId: p.contractId != null ? String(p.contractId) : null,
  categoryId: p.categoryId != null ? String(p.categoryId) : null,
  recurring: false,
  frequency: 'monthly',
  until: '',
});

// Create or edit a payment (entrada or saída). Shared by Fluxo de Caixa and the
// contract page; pass `payment` to edit, or null to create.
export default function PaymentFormModal({
  opened,
  payment,
  onClose,
  onSaved,
}: {
  opened: boolean;
  payment: Payment | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const { data: customers = [] } = useQuery({ queryKey: ['/customers'], queryFn: () => api.get<Customer[]>('/customers'), enabled: opened });
  const { data: contracts = [] } = useQuery({ queryKey: ['/contracts'], queryFn: () => api.get<ContractSummary[]>('/contracts'), enabled: opened });
  const { data: categories = [] } = useQuery({ queryKey: ['/categories'], queryFn: () => api.get<Category[]>('/categories'), enabled: opened });

  const [fm, setFm] = useState<FormState>(blank);
  useEffect(() => {
    if (opened) setFm(payment ? fromPayment(payment) : blank());
  }, [opened, payment]);

  const customerOptions = customers.map((c) => ({ value: String(c.id), label: c.nickname || c.name }));
  const contractOptions = contracts.map((c) => ({
    value: String(c.id),
    label: `${c.number ?? `#${c.id}`}${c.customerName ? ` — ${c.customerName}` : ''}`,
  }));
  const categoryOptions = categories.map((c) => ({ value: String(c.id), label: c.name }));

  // A recurrence is only offered when creating; editing a series goes through the scope dialog.
  const recurring = !payment && fm.recurring;
  const occurrences = recurring ? recurrenceDates(fm.dueDate, fm.frequency, fm.until) : [];
  const recurrenceInvalid = recurring && (!fm.dueDate || !fm.until || occurrences.length === 0 || occurrences.length > MAX_OCCURRENCES);

  const settled = !recurring && isSettled(fm.flow, fm.situation);

  // Which payments of a series an edit applies to (asked when the payment is recurring).
  const [scopeOpen, setScopeOpen] = useState(false);

  const save = useMutation({
    mutationFn: (scope?: SeriesScope) => {
      const base = {
        description: fm.description || 'Pagamento',
        amount: Number(fm.amount) || 0,
        flow: fm.flow,
        dueDate: fm.dueDate || null,
        customerId: fm.customerId ? Number(fm.customerId) : null,
        contractId: fm.contractId ? Number(fm.contractId) : null,
        categoryId: fm.categoryId ? Number(fm.categoryId) : null,
      };
      // Write only the fields of the chosen direction and reset the other side, so
      // changing Tipo can't leave a stale status or date behind. The settle date
      // defaults to today when marking as received/paid, and is cleared otherwise.
      const settleDate = settled ? fm.settleDate || todayIso() : null;
      const payload =
        fm.flow === 'in'
          ? { ...base, receiptStatus: fm.situation, receivedDate: settleDate, status: 'upcoming', paidDate: null }
          : { ...base, status: fm.situation, paidDate: settleDate, receiptStatus: 'open', receivedDate: null };
      if (payment) {
        return api.put(`/payments/${payment.id}`, scope && scope !== 'one' ? { ...payload, scope } : payload);
      }
      // New recurring payment: the server creates one open payment per date.
      if (recurring) return api.post('/payments', { ...payload, recurrence: { frequency: fm.frequency, until: fm.until } });
      return api.post('/payments', payload);
    },
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['/payments'] });
      qc.invalidateQueries({ queryKey: ['/contracts'] });
      onSaved?.();
      setScopeOpen(false);
      onClose();
      const n = res?.count;
      notifications.show({ message: n ? `${n} pagamentos criados` : 'Pagamento salvo', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  return (
    <Modal opened={opened} onClose={onClose} title={payment ? 'Editar pagamento' : 'Novo pagamento'}>
      <Stack>
        <TextInput label="Descrição" value={fm.description} onChange={(e) => setFm({ ...fm, description: e.currentTarget.value })} />
        <Group grow>
          <NumberInput label="Valor (R$)" prefix="R$ " decimalScale={2} value={fm.amount} onChange={(v) => setFm({ ...fm, amount: v })} />
          <Select
            label="Tipo"
            data={[
              { value: 'in', label: 'Entrada' },
              { value: 'out', label: 'Saída' },
            ]}
            value={fm.flow}
            allowDeselect={false}
            // Situação options differ per direction, so reset it when Tipo changes.
            onChange={(v) => {
              const flow = (v as Flow) ?? fm.flow;
              setFm({ ...fm, flow, situation: DEFAULT_SITUATION[flow], settleDate: '' });
            }}
          />
        </Group>
        {/* A new recurring series always starts open, so Situação only applies otherwise. */}
        {!recurring && (
          <Group grow>
            <Select
              label="Situação"
              data={SITUATIONS[fm.flow]}
              value={fm.situation}
              allowDeselect={false}
              onChange={(v) => setFm({ ...fm, situation: v ?? DEFAULT_SITUATION[fm.flow] })}
            />
            {settled && (
              <DateField
                label={fm.flow === 'in' ? 'Data de recebimento' : 'Data de pagamento'}
                value={fm.settleDate}
                onChange={(v) => setFm({ ...fm, settleDate: v })}
              />
            )}
          </Group>
        )}
        {payment?.recurrenceId && (
          <Text size="xs" c="dimmed">
            Este pagamento faz parte de uma série recorrente: ao salvar, você escolhe a quais pagamentos da série aplicar.
          </Text>
        )}
        <Group grow>
          <Select label="Cliente" placeholder="Nenhum (operacional)" data={customerOptions} value={fm.customerId} onChange={(v) => setFm({ ...fm, customerId: v })} clearable searchable />
          <Select label="Contrato" placeholder="Nenhum" data={contractOptions} value={fm.contractId} onChange={(v) => setFm({ ...fm, contractId: v })} clearable searchable />
        </Group>
        <Group grow>
          <Select label="Categoria" placeholder="Nenhuma" data={categoryOptions} value={fm.categoryId} onChange={(v) => setFm({ ...fm, categoryId: v })} clearable searchable />
          <DateField
            label={recurring ? 'Primeiro vencimento' : 'Vencimento'}
            value={fm.dueDate}
            onChange={(v) => setFm({ ...fm, dueDate: v })}
          />
        </Group>

        {!payment && (
          <>
            <Switch
              label="Pagamento recorrente"
              description="Cria um pagamento a cada período, até a data final (ex.: mensalidade de um software)."
              checked={fm.recurring}
              onChange={(e) => setFm({ ...fm, recurring: e.currentTarget.checked })}
            />
            {fm.recurring && (
              <>
                <Group grow>
                  <Select
                    label="Frequência"
                    data={FREQUENCY_OPTIONS}
                    value={fm.frequency}
                    allowDeselect={false}
                    onChange={(v) => setFm({ ...fm, frequency: (v as Frequency) ?? 'monthly' })}
                  />
                  <DateField label="Repetir até" value={fm.until} onChange={(v) => setFm({ ...fm, until: v })} />
                </Group>
                {occurrences.length > MAX_OCCURRENCES ? (
                  <Alert color="red" variant="light">
                    Esse período geraria mais de {MAX_OCCURRENCES} pagamentos. Reduza a data final ou use uma frequência maior.
                  </Alert>
                ) : fm.until && occurrences.length === 0 ? (
                  <Alert color="red" variant="light">
                    A data final deve ser igual ou posterior ao primeiro vencimento.
                  </Alert>
                ) : occurrences.length > 0 ? (
                  <Alert color={occurrences.length > MANY_OCCURRENCES ? 'yellow' : 'blue'} variant="light">
                    Serão criados <b>{occurrences.length}</b> {occurrences.length === 1 ? 'pagamento' : 'pagamentos'}
                    , do dia {occurrences[0].split('-').reverse().join('/')} ao dia{' '}
                    {occurrences[occurrences.length - 1].split('-').reverse().join('/')}.
                    {occurrences.length > MANY_OCCURRENCES ? ' São muitos pagamentos — confira se é isso mesmo.' : ''}
                  </Alert>
                ) : null}
              </>
            )}
          </>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={save.isPending && !scopeOpen}
            disabled={recurrenceInvalid}
            // Editing a recurring payment asks which payments of the series to change.
            onClick={() => (payment?.recurrenceId ? setScopeOpen(true) : save.mutate(undefined))}
          >
            {recurring ? 'Criar pagamentos' : 'Salvar'}
          </Button>
        </Group>
      </Stack>

      <RecurrenceScopeModal
        opened={scopeOpen}
        payment={payment}
        mode="save"
        loading={save.isPending}
        onClose={() => setScopeOpen(false)}
        onConfirm={(scope) => save.mutate(scope)}
      />
    </Modal>
  );
}
