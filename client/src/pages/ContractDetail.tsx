import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Stack,
  Group,
  Title,
  Text,
  Paper,
  Button,
  Badge,
  Table,
  Modal,
  TextInput,
  Textarea,
  Checkbox,
  ActionIcon,
  Anchor,
  Divider,
  Breadcrumbs,
  NumberInput,
  Alert,
  Switch,
} from '@mantine/core';
import { Select } from '../components/Select';
import { IconArrowLeft, IconArrowRight, IconPlus, IconTrash, IconFileText, IconEdit, IconCheck } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, ContractDetail as CD, Payment, CustomerCredit, AppSettings, ContractStatus, ContractItem, ServiceDetail, Category } from '../api/client';
import { STATUS_LABELS, STATUS_COLORS, isOverdue, statusDeadline, nextStatus, prevStatus } from '../lib/status';
import PerformedServicePicker, { PerformedValue, emptyPerformed } from '../components/PerformedServicePicker';
import InstallmentPlanner, { InstallmentValue } from '../components/InstallmentPlanner';
import DateField from '../components/DateField';
import { downloadFile, generateReceipt } from '../lib/download';
import { paymentSituation } from '../lib/paymentStatus';
import { MONEY_INPUT_BRL } from '../lib/money';
import PaymentFormModal from '../components/PaymentFormModal';
import ContractFormModal from '../components/ContractFormModal';
import { addBusinessDaysIso, todayIso, formatBr } from '../lib/dates';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Prefer the server-provided filename (Content-Disposition) over a fallback.


export default function ContractDetail() {
  const { id } = useParams();
  const contractId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const key = ['/contracts', contractId, 'detail'];
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['/contracts'] });
    qc.invalidateQueries({ queryKey: ['/payments'] });
  };

  const { data: c, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<CD>(`/contracts/${contractId}`) });
  const { data: settings } = useQuery({ queryKey: ['/settings'], queryFn: () => api.get<AppSettings>('/settings') });
  const err = (e: Error) => notifications.show({ message: e.message, color: 'red' });

  const changeStatus = useMutation({
    mutationFn: (status: ContractStatus) => api.put(`/contracts/${contractId}/status`, { status }),
    onSuccess: () => invalidate(),
    onError: err,
  });

  const [editOpen, setEditOpen] = useState(false); // shared ContractFormModal

  // ---- add performed service (recurring) ----
  // A quantity > 1 creates that many separate single-unit items, each with its
  // own description and additionals.
  const [addOpen, setAddOpen] = useState(false);
  const [perf, setPerf] = useState<PerformedValue>(emptyPerformed());
  const [performedAt, setPerformedAt] = useState('');
  // The services list shows only what is not yet invoiced, unless toggled on.
  const [showInvoiced, setShowInvoiced] = useState(false);
  const openAdd = () => {
    setPerf(emptyPerformed());
    setPerformedAt('');
    setAddOpen(true);
  };
  const addItem = useMutation({
    mutationFn: () =>
      api.post(`/contracts/${contractId}/items`, {
        serviceVersionId: perf.serviceVersionId,
        performedAt: performedAt || null,
        // One item per unit; each is quantity 1 with its own description/additionals.
        items: perf.items.map((it) => ({
          description: it.description,
          additionals: it.additionals.filter((a) => a.qty > 0).map((a) => ({ additionalId: a.id, quantity: a.qty })),
        })),
      }),
    onSuccess: () => {
      invalidate();
      setAddOpen(false);
      const n = perf.items.length;
      notifications.show({ message: n > 1 ? `${n} serviços adicionados` : 'Serviço adicionado', color: 'green' });
    },
    onError: err,
  });
  const removeItem = useMutation({
    mutationFn: (itemId: number) => api.del(`/contracts/${contractId}/items/${itemId}`),
    onSuccess: invalidate,
    onError: err,
  });

  // ---- edit an unbilled performed service ----
  const [itemEditOpen, setItemEditOpen] = useState(false);
  const [itemEditId, setItemEditId] = useState<number | null>(null);
  const [itemEditPerf, setItemEditPerf] = useState<PerformedValue>(emptyPerformed());
  const [itemEditAt, setItemEditAt] = useState('');
  const openItemEdit = async (it: ContractItem) => {
    if (!it.serviceId) return;
    // Load the service's current version to show all available additionals, then
    // apply this item's chosen quantities by additional id.
    const detail = await qc.fetchQuery({
      queryKey: ['/services', it.serviceId],
      queryFn: () => api.get<ServiceDetail>(`/services/${it.serviceId}`),
    });
    const cur = detail.versions.find((v) => v.active) ?? detail.versions[0];
    const chosen = new Map(it.additionals.map((a) => [a.additionalId, a.quantity]));
    const adds = (cur?.additionals ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      unitPrice: Number(a.price),
      qty: chosen.get(a.id) ?? 0,
    }));
    setItemEditPerf({
      serviceId: it.serviceId,
      serviceVersionId: cur?.id ?? it.serviceVersionId ?? null,
      basePrice: Number(cur?.basePrice ?? it.basePrice),
      items: [{ description: it.description ?? '', additionals: adds }],
    });
    setItemEditAt(it.performedAt ?? '');
    setItemEditId(it.id);
    setItemEditOpen(true);
  };
  const editItem = useMutation({
    mutationFn: () => {
      const one = itemEditPerf.items[0];
      return api.put(`/contracts/${contractId}/items/${itemEditId}`, {
        serviceVersionId: itemEditPerf.serviceVersionId,
        performedAt: itemEditAt || null,
        description: one?.description ?? '',
        additionals: (one?.additionals ?? [])
          .filter((a) => a.qty > 0)
          .map((a) => ({ additionalId: a.id, quantity: a.qty })),
      });
    },
    onSuccess: () => {
      invalidate();
      setItemEditOpen(false);
      notifications.show({ message: 'Serviço atualizado', color: 'green' });
    },
    onError: err,
  });

  // ---- create invoice ----
  const [invOpen, setInvOpen] = useState(false);
  const [invRef, setInvRef] = useState('');
  const [invComments, setInvComments] = useState('');
  const [invSelected, setInvSelected] = useState<number[]>([]);
  const [invDiscPct, setInvDiscPct] = useState<number | string>(0);
  const [invMods, setInvMods] = useState<{ name: string; price: number | string; disc: number | string }[]>([]);
  const [invCreditId, setInvCreditId] = useState<string | null>(null);
  // Description for the credit created when a fatura comes out negative.
  const [invCreditDesc, setInvCreditDesc] = useState('');
  const [invPlan, setInvPlan] = useState<InstallmentValue>({ count: 1, dueDates: [] });
  // null = creating a new fatura; a number = editing that invoice.
  const [invEditId, setInvEditId] = useState<number | null>(null);
  const openInvoice = () => {
    setInvEditId(null);
    setInvRef('');
    setInvComments('');
    setInvSelected([]);
    setInvDiscPct(0);
    setInvMods([]);
    setInvCreditId(null);
    setInvCreditDesc('');
    setInvPlan({ count: 1, dueDates: [addBusinessDaysIso(todayIso(), 5)] });
    setInvOpen(true);
  };
  const openInvoiceEdit = (inv: CD['invoices'][number]) => {
    if (!c) return;
    setInvEditId(inv.id);
    setInvRef(inv.reference ?? '');
    setInvComments(inv.comments ?? '');
    setInvSelected(c.items.filter((it) => it.invoiceId === inv.id).map((it) => it.id));
    setInvDiscPct(Number(inv.discountPercent) || 0);
    setInvMods(inv.modifiers.map((m) => ({ name: m.name, price: Number(m.price), disc: Number(m.discountPercent) })));
    setInvCreditId(inv.creditId ? String(inv.creditId) : null);
    setInvCreditDesc('');
    const dueDates = inv.payments
      .filter((p) => p.dueDate)
      .map((p) => p.dueDate as string)
      .sort();
    setInvPlan({
      count: inv.installments || 1,
      dueDates: dueDates.length ? dueDates : [addBusinessDaysIso(todayIso(), 5)],
    });
    setInvOpen(true);
  };
  // Load ALL credits (?all=1): a credit this invoice consumed completely has remaining 0 and
  // would otherwise be missing from the edit modal. Fully used credits are then filtered
  // out below, except the one already applied to the invoice being edited.
  const { data: allCredits = [] } = useQuery({
    queryKey: ['/customers', c?.customerId, 'credits', 'all'],
    queryFn: () => api.get<CustomerCredit[]>(`/customers/${c!.customerId}/credits?all=1`),
    enabled: invOpen && !!c?.customerId,
  });
  const appliedCreditId = invEditId ? c?.invoices.find((v) => v.id === invEditId)?.creditId ?? null : null;
  const custCredits = allCredits.filter((cr) => Number(cr.remaining) > 0 || cr.id === appliedCreditId);
  const saveInvoice = useMutation({
    mutationFn: () => {
      const body = {
        reference: invRef,
        comments: invComments,
        itemIds: invSelected,
        discountPercent: Number(invDiscPct) || 0,
        modifiers: invMods
          .filter((m) => m.name)
          .map((m) => ({ name: m.name, price: Number(m.price) || 0, discountPercent: Number(m.disc) || 0 })),
        creditId: invCreditId ? Number(invCreditId) : null,
        creditDescription: invCreditDesc,
        installments: invPlan.count,
        dueDates: invPlan.dueDates,
      };
      return invEditId
        ? api.put(`/invoices/${invEditId}`, body)
        : api.post(`/contracts/${contractId}/invoices`, body);
    },
    onSuccess: () => {
      invalidate();
      // A negative fatura banks/reinstates credit — reflect it here.
      qc.invalidateQueries({ queryKey: ['/customers', c?.customerId, 'credits'] });
      setInvOpen(false);
      notifications.show({ message: invEditId ? 'Fatura atualizada' : 'Fatura criada', color: 'green' });
    },
    onError: err,
  });
  const deleteInvoice = useMutation({
    mutationFn: (invId: number) => api.del(`/invoices/${invId}`),
    onSuccess: invalidate,
    onError: err,
  });
  const genInvoice = useMutation({
    mutationFn: (invId: number) => api.post(`/invoices/${invId}/generate`, {}),
    onSuccess: () => {
      invalidate();
      notifications.show({ message: 'Documento da fatura gerado', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ title: 'Erro ao gerar', message: e.message, color: 'red' }),
  });

  // ---- generate one-time contract (uses the contract's own comments) ----
  const genContract = useMutation({
    mutationFn: () => api.post(`/contracts/${contractId}/generate`, {}),
    onSuccess: () => {
      invalidate();
      notifications.show({ message: 'Documento gerado', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ title: 'Erro ao gerar', message: e.message, color: 'red' }),
  });

  const deleteDoc = useMutation({
    mutationFn: (docId: number) => api.del(`/contract-documents/${docId}`),
    onSuccess: invalidate,
    onError: err,
  });

  // ---- extra payment (added after signing) ----
  // An extra payment is linked to the contract but is NOT part of its value or
  // installments (no installmentNumber); a category is mandatory so it is always
  // classified in Fluxo de Caixa / Relatórios.
  const { data: categories = [] } = useQuery({
    queryKey: ['/categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });
  const [payOpen, setPayOpen] = useState(false);
  const [payDesc, setPayDesc] = useState('');
  const [payAmount, setPayAmount] = useState<number | string>(0);
  const [payFlow, setPayFlow] = useState('in');
  const [payStatus, setPayStatus] = useState('open'); // entrada: open|received; saída: upcoming|done
  const [payDue, setPayDue] = useState('');
  const [payCat, setPayCat] = useState<string | null>(null);
  const [payTried, setPayTried] = useState(false); // show inline errors after the first click on Adicionar
  const payDescError = payDesc.trim() === '' ? 'Informe a descrição.' : null;
  const payAmountError = !(Number(payAmount) > 0) ? 'Informe um valor maior que zero.' : null;
  const openPayment = () => {
    setPayDesc('');
    setPayAmount(0);
    setPayFlow('in');
    setPayStatus('open');
    setPayDue(todayIso());
    setPayCat(null);
    setPayTried(false);
    setPayOpen(true);
  };
  const addPayment = useMutation({
    mutationFn: () =>
      api.post('/payments', {
        contractId,
        customerId: c?.customerId ?? null,
        categoryId: payCat ? Number(payCat) : null,
        description: payDesc.trim(),
        amount: Number(payAmount),
        flow: payFlow,
        dueDate: payDue || null,
        // Entrada uses the receipt lifecycle (receiptStatus), saída the paid/unpaid status —
        // same mapping as PaymentFormModal. Settled ones get today as received/paid date.
        ...(payFlow === 'in'
          ? {
              receiptStatus: payStatus,
              receivedDate: payStatus === 'open' ? null : todayIso(),
              status: 'upcoming',
              paidDate: null,
            }
          : {
              status: payStatus,
              paidDate: payStatus === 'done' ? todayIso() : null,
              receiptStatus: 'open',
              receivedDate: null,
            }),
      }),
    onSuccess: () => {
      invalidate();
      setPayOpen(false);
      notifications.show({ message: 'Pagamento adicionado', color: 'green' });
    },
    onError: err,
  });
  // Edit any existing payment (status included) with the shared payment form.
  const [editPay, setEditPay] = useState<Payment | null>(null);
  const removePayment = useMutation({
    mutationFn: (pid: number) => api.del(`/payments/${pid}`),
    onSuccess: invalidate,
    onError: err,
  });

  // ---- mark receipt received ----
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

  if (isLoading || !c) return <Text>Carregando…</Text>;

  const unbilled = c.items.filter((it) => !it.invoiceId);
  // Rows in the services list: only not-yet-invoiced, unless "Mostrar faturados" is on.
  const visibleItems = showInvoiced ? c.items : unbilled;
  // Items selectable in the fatura modal: open items, plus (when editing) the
  // items already on the invoice being edited.
  const candidateItems = invEditId
    ? [...unbilled, ...c.items.filter((it) => it.invoiceId === invEditId)]
    : unbilled;

  return (
    <Stack>
      <Breadcrumbs>
        <Anchor onClick={() => navigate('/contracts')}>
          <Group gap={4}>
            <IconArrowLeft size={14} /> Contratos
          </Group>
        </Anchor>
        <Text>{c.number ?? `#${c.id}`}</Text>
      </Breadcrumbs>

      {/* header */}
      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap="xs">
              <Badge size="lg" variant="filled" color="dark">
                {c.number ?? `#${c.id}`}
              </Badge>
              <Title order={3}>{c.title || 'Contrato'}</Title>
              <Badge variant="light" color={c.type === 'invoice' ? 'blue' : 'teal'}>
                {c.type === 'invoice' ? 'Fatura (recorrente)' : 'Contrato (único)'}
              </Badge>
            </Group>
            <Text c="dimmed">{c.customer?.name ?? 'Sem cliente'}</Text>
            {c.comments && <Text size="sm" mt={4}>{c.comments}</Text>}
          </div>
          <Group>
            <Text fw={700}>{brl(Number(c.total))}</Text>
            <ActionIcon variant="subtle" onClick={() => setEditOpen(true)} title="Editar">
              <IconEdit size={16} />
            </ActionIcon>
          </Group>
        </Group>
      </Paper>

      {/* status workflow (one-time contracts) */}
      {c.type === 'contract' && (
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between" align="center" wrap="wrap">
            <Group gap="sm">
              <Text fw={500} size="sm">
                Status:
              </Text>
              {(() => {
                const overdue = isOverdue(c.status, c.statusChangedAt, settings);
                const dl = statusDeadline(c.status, c.statusChangedAt, settings);
                return (
                  <>
                    <Badge size="lg" variant="light" color={overdue ? 'red' : STATUS_COLORS[c.status]}>
                      {STATUS_LABELS[c.status]}
                    </Badge>
                    {dl && (
                      <Text size="sm" c={overdue ? 'red' : 'dimmed'}>
                        Prazo: {dl.toLocaleDateString('pt-BR')}
                        {overdue ? ' · atrasado' : ''}
                      </Text>
                    )}
                  </>
                );
              })()}
            </Group>
            <Group gap="xs">
              <Button
                size="xs"
                variant="default"
                leftSection={<IconArrowLeft size={14} />}
                disabled={!prevStatus(c.status) || changeStatus.isPending}
                onClick={() => {
                  const p = prevStatus(c.status);
                  if (p) changeStatus.mutate(p);
                }}
              >
                Voltar
              </Button>
              <Button
                size="xs"
                rightSection={<IconArrowRight size={14} />}
                disabled={!nextStatus(c.status) || changeStatus.isPending}
                onClick={() => {
                  const n = nextStatus(c.status);
                  if (n) changeStatus.mutate(n);
                }}
              >
                Avançar
              </Button>
            </Group>
          </Group>
        </Paper>
      )}

      {c.type === 'contract' ? (
        <OneTimeView
          c={c}
          onGenerate={() => genContract.mutate()}
          generating={genContract.isPending}
          onDeleteDoc={(docId) => deleteDoc.mutate(docId)}
          onAddPayment={openPayment}
          onEditPayment={(p) => setEditPay(p)}
          onRemovePayment={(pid) => removePayment.mutate(pid)}
          onMarkReceived={(p) => {
            setRecvFor(p);
            setRecvDate(todayIso());
          }}
          onGenerateReceipt={async (pid, format) => {
            if (await generateReceipt(pid, format)) invalidate();
          }}
        />
      ) : (
        <>
          {/* performed services */}
          <Paper withBorder p="md" radius="md">
            <Group justify="space-between" mb="sm">
              <Title order={4}>Serviços realizados</Title>
              <Group>
                <Switch label="Mostrar faturados" checked={showInvoiced} onChange={(e) => setShowInvoiced(e.currentTarget.checked)} />
                <Button size="xs" leftSection={<IconPlus size={14} />} onClick={openAdd}>
                  Adicionar serviço
                </Button>
              </Group>
            </Group>
            <Table.ScrollContainer minWidth={640}>
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Data</Table.Th>
                    <Table.Th>Serviço</Table.Th>
                    <Table.Th>Descrição</Table.Th>
                    <Table.Th ta="center">Qtd.</Table.Th>
                    <Table.Th ta="right">Valor</Table.Th>
                    <Table.Th>Situação</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {visibleItems.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={7}>
                        <Text c="dimmed">
                          {c.items.length === 0
                            ? 'Nenhum serviço realizado ainda.'
                            : 'Nenhum serviço em aberto. Ative "Mostrar faturados" para ver os já faturados.'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  )}
                  {visibleItems.map((it) => {
                    const inv = c.invoices.find((v) => v.id === it.invoiceId);
                    return (
                      <Table.Tr key={it.id}>
                        <Table.Td>{formatBr(it.performedAt)}</Table.Td>
                        <Table.Td>
                          {it.serviceName} {it.version ? <Badge size="xs" variant="light">v{it.version}</Badge> : null}
                          {it.additionals.length > 0 && (
                            <Text size="xs" c="dimmed">
                              {it.additionals.map((a) => `${a.name} x${a.quantity}`).join(', ')}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>{it.description ?? '—'}</Table.Td>
                        <Table.Td ta="center">{it.quantity}</Table.Td>
                        <Table.Td ta="right">{brl(Number(it.lineTotal))}</Table.Td>
                        <Table.Td>
                          {it.invoiceId ? (
                            <Badge color="blue" variant="light">
                              Faturado{inv?.reference ? ` · ${inv.reference}` : ` #${it.invoiceId}`}
                            </Badge>
                          ) : (
                            <Badge color="yellow" variant="light">
                              Em aberto
                            </Badge>
                          )}
                        </Table.Td>
                        <Table.Td>
                          {!it.invoiceId && (
                            <Group gap={4} wrap="nowrap" justify="flex-end">
                              <ActionIcon variant="subtle" onClick={() => openItemEdit(it)} title="Editar" disabled={!it.serviceId}>
                                <IconEdit size={16} />
                              </ActionIcon>
                              <ActionIcon color="red" variant="subtle" onClick={() => removeItem.mutate(it.id)} title="Remover">
                                <IconTrash size={16} />
                              </ActionIcon>
                            </Group>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>

          {/* invoices */}
          <Paper withBorder p="md" radius="md">
            <Group justify="space-between" mb="sm">
              <Title order={4}>Faturas</Title>
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={openInvoice} disabled={unbilled.length === 0}>
                Nova fatura
              </Button>
            </Group>
            {c.invoices.length === 0 && <Text c="dimmed">Nenhuma fatura gerada.</Text>}
            <Stack>
              {c.invoices.map((inv) => (
                <Paper key={inv.id} withBorder p="sm" radius="md">
                  <Group justify="space-between">
                    <div>
                      <Text fw={500}>
                        {inv.refNumber ? `${inv.refNumber} · ` : ''}
                        {inv.reference || `Fatura #${inv.id}`} — {brl(Number(inv.total) - Number(inv.creditApplied ?? 0))}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {new Date(inv.createdAt).toLocaleDateString('pt-BR')}
                        {inv.installments > 1 ? ` · ${inv.installments}x` : ''}
                        {Number(inv.discountPercent) > 0 ? ` · desc. ${Number(inv.discountPercent)}%` : ''}
                        {Number(inv.creditApplied) > 0 ? ` · crédito -${brl(Number(inv.creditApplied))}` : ''}
                        {inv.comments ? ` · ${inv.comments}` : ''}
                      </Text>
                    </div>
                    <Group gap="xs">
                      <Button size="compact-xs" variant="light" leftSection={<IconFileText size={14} />} loading={genInvoice.isPending} onClick={() => genInvoice.mutate(inv.id)}>
                        Gerar documento
                      </Button>
                      <ActionIcon variant="subtle" title="Editar fatura" onClick={() => openInvoiceEdit(inv)}>
                        <IconEdit size={16} />
                      </ActionIcon>
                      <ActionIcon color="red" variant="subtle" title="Excluir fatura" onClick={() => { if (confirm('Excluir a fatura? Os serviços voltam a ficar em aberto.')) deleteInvoice.mutate(inv.id); }}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Group>
                  {inv.documents.length > 0 && (
                    <Stack gap={4} mt="xs">
                      {inv.documents.map((d) => (
                        <Group key={d.id} gap={6} wrap="nowrap">
                          <Text size="sm" style={{ flex: 1 }} truncate>
                            {d.fileName}
                          </Text>
                          <Button
                            size="compact-xs"
                            variant="light"
                            leftSection={<IconFileText size={14} />}
                            onClick={() => downloadFile(`/api/contract-documents/${d.id}/download`, d.fileName)}
                          >
                            Baixar
                          </Button>
                          <Button
                            size="compact-xs"
                            variant="light"
                            onClick={() =>
                              downloadFile(
                                `/api/contract-documents/${d.id}/pdf`,
                                d.fileName.replace(/\.(docx|odt)$/i, '') + '.pdf'
                              )
                            }
                          >
                            PDF
                          </Button>
                          <ActionIcon size="sm" variant="subtle" color="red" title="Excluir documento" onClick={() => { if (confirm('Excluir este documento? O arquivo também será apagado.')) deleteDoc.mutate(d.id); }}>
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Group>
                      ))}
                    </Stack>
                  )}
                </Paper>
              ))}
            </Stack>
          </Paper>
        </>
      )}

      {/* shared edit modal (same as the contracts list) */}
      <ContractFormModal opened={editOpen} editingId={contractId} onClose={() => setEditOpen(false)} onSaved={() => invalidate()} />

      {/* add performed service modal */}
      <Modal opened={addOpen} onClose={() => setAddOpen(false)} title="Adicionar serviço realizado" size="lg">
        <Stack>
          <PerformedServicePicker value={perf} onChange={setPerf} />
          <DateField label="Data de realização" value={performedAt} onChange={setPerformedAt} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setAddOpen(false)}>
              Cancelar
            </Button>
            <Button loading={addItem.isPending} disabled={!perf.serviceVersionId} onClick={() => addItem.mutate()}>
              Adicionar
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* edit performed service modal (only while unbilled) */}
      <Modal opened={itemEditOpen} onClose={() => setItemEditOpen(false)} title="Editar serviço realizado" size="lg">
        <Stack>
          <PerformedServicePicker value={itemEditPerf} onChange={setItemEditPerf} lockQuantity />
          <DateField label="Data de realização" value={itemEditAt} onChange={setItemEditAt} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setItemEditOpen(false)}>
              Cancelar
            </Button>
            <Button loading={editItem.isPending} disabled={!itemEditPerf.serviceVersionId} onClick={() => editItem.mutate()}>
              Salvar
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* new / edit invoice modal */}
      <Modal opened={invOpen} onClose={() => setInvOpen(false)} title={invEditId ? 'Editar fatura' : 'Nova fatura'} size="lg">
        <Stack>
          <TextInput label="Referência" placeholder="Ex.: Agosto/2026" value={invRef} onChange={(e) => setInvRef(e.currentTarget.value)} />
          <Text size="sm" fw={500}>
            Serviços
          </Text>
          <Stack gap={4}>
            {candidateItems.map((it) => (
              <Checkbox
                key={it.id}
                checked={invSelected.includes(it.id)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setInvSelected((s) => (on ? [...s, it.id] : s.filter((x) => x !== it.id)));
                }}
                label={`${it.performedAt ? formatBr(it.performedAt) + ' ' : ''}${it.serviceName}${it.quantity > 1 ? ` (x${it.quantity})` : ''}${it.description ? ` — ${it.description}` : ''} · ${brl(Number(it.lineTotal))}`}
              />
            ))}
          </Stack>
          <NumberInput label="Desconto (%)" min={0} max={100} suffix="%" value={invDiscPct} onChange={setInvDiscPct} w={180} />

          <Paper withBorder p="sm" radius="md">
            <Group justify="space-between" mb="xs">
              <Text fw={500} size="sm">
                Modificadores
              </Text>
              <Button size="compact-xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setInvMods((m) => [...m, { name: '', price: 0, disc: 0 }])}>
                Adicionar
              </Button>
            </Group>
            {invMods.length === 0 && (
              <Text size="xs" c="dimmed">
                Nenhum modificador.
              </Text>
            )}
            {invMods.map((m, i) => (
              <Group key={i} gap="xs" wrap="nowrap" mb={4}>
                <TextInput placeholder="Descrição" value={m.name} onChange={(e) => setInvMods((arr) => arr.map((x, idx) => (idx === i ? { ...x, name: e.currentTarget.value } : x)))} style={{ flex: 1 }} />
                <NumberInput placeholder="Valor" {...MONEY_INPUT_BRL} w={130} value={m.price} onChange={(v) => setInvMods((arr) => arr.map((x, idx) => (idx === i ? { ...x, price: v } : x)))} />
                <NumberInput placeholder="Desc." suffix="%" min={0} max={100} w={90} value={m.disc} onChange={(v) => setInvMods((arr) => arr.map((x, idx) => (idx === i ? { ...x, disc: v } : x)))} />
                <ActionIcon color="red" variant="subtle" onClick={() => setInvMods((arr) => arr.filter((_, idx) => idx !== i))}>
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            ))}
          </Paper>

          <Textarea label="Comentários" value={invComments} onChange={(e) => setInvComments(e.currentTarget.value)} autosize minRows={2} />
          {(() => {
            const subtotal = candidateItems.filter((it) => invSelected.includes(it.id)).reduce((s, it) => s + Number(it.lineTotal), 0);
            const modsSum = invMods.reduce((s, m) => s + (Number(m.price) || 0) * (1 - (Number(m.disc) || 0) / 100), 0);
            const rawFinal = subtotal * (1 - (Number(invDiscPct) || 0) / 100) + modsSum;
            const negative = rawFinal < 0;
            const surplus = negative ? -rawFinal : 0;
            const final = Math.max(0, rawFinal);
            const selCredit = negative ? undefined : custCredits.find((cr) => String(cr.id) === invCreditId);
            // When editing, the amount this invoice already applied is reinstated
            // server-side before re-applying, so preview it as available again.
            const editingInv = invEditId ? c.invoices.find((v) => v.id === invEditId) : undefined;
            const reinstated =
              selCredit && editingInv && editingInv.creditId === selCredit.id ? Number(editingInv.creditApplied ?? 0) : 0;
            const selRemaining = selCredit ? Number(selCredit.remaining) + reinstated : 0;
            const creditApplied = selCredit ? Math.min(selRemaining, final) : 0;
            const afterCredit = Math.max(0, final - creditApplied);
            return (
              <>
                {/* A negative fatura becomes a credit for the customer instead of a charge. */}
                {negative && invEditId ? (
                  <Alert color="red" variant="light">
                    <Text size="sm">
                      Uma fatura não pode ficar negativa ({brl(rawFinal)}) ao ser editada. Para gerar um
                      crédito, exclua esta fatura e crie uma nova.
                    </Text>
                  </Alert>
                ) : negative ? (
                  <Alert color="blue" variant="light">
                    <Text size="sm" mb="xs">
                      Esta fatura ficou negativa ({brl(rawFinal)}). Será criado um crédito de{' '}
                      <b>{brl(surplus)}</b> para o cliente.
                    </Text>
                    <TextInput
                      label="Descrição do crédito"
                      placeholder="Ex.: Crédito por serviço cancelado"
                      value={invCreditDesc}
                      onChange={(e) => setInvCreditDesc(e.currentTarget.value)}
                    />
                  </Alert>
                ) : (
                  custCredits.length > 0 && (
                    <Select
                      label="Usar crédito do cliente"
                      placeholder="Nenhum"
                      clearable
                      searchable
                      data={custCredits.map((cr) => ({
                        value: String(cr.id),
                        label: `${cr.description} — restante ${brl(
                          Number(cr.remaining) + (editingInv && editingInv.creditId === cr.id ? Number(editingInv.creditApplied ?? 0) : 0)
                        )}`,
                      }))}
                      value={invCreditId}
                      onChange={setInvCreditId}
                    />
                  )
                )}
                <Text size="sm" c="dimmed" ta="right">
                  Subtotal: {brl(subtotal)}
                  {modsSum ? ` · Modificadores: ${brl(modsSum)}` : ''} · Total: {brl(final)}
                  {negative ? ` · Crédito gerado: ${brl(surplus)}` : ''}
                  {creditApplied ? ` · Crédito: -${brl(creditApplied)} · A parcelar: ${brl(afterCredit)}` : ''}
                </Text>
                <Divider label="Parcelamento" />
                <InstallmentPlanner amount={afterCredit} value={invPlan} onChange={setInvPlan} />
                <Group justify="flex-end">
                  <Button variant="default" onClick={() => setInvOpen(false)}>
                    Cancelar
                  </Button>
                  <Button
                    loading={saveInvoice.isPending}
                    disabled={invSelected.length === 0 || (negative && !!invEditId)}
                    onClick={() => saveInvoice.mutate()}
                  >
                    {invEditId ? 'Salvar alterações' : 'Criar fatura'}
                  </Button>
                </Group>
              </>
            );
          })()}
        </Stack>
      </Modal>

      {/* edit payment modal (shared with Fluxo de Caixa) */}
      <PaymentFormModal opened={editPay != null} payment={editPay} onClose={() => setEditPay(null)} onSaved={() => invalidate()} />

      {/* add extra payment modal */}
      <Modal opened={payOpen} onClose={() => setPayOpen(false)} title="Pagamento extra">
        <Stack>
          <TextInput label="Descrição" required value={payDesc} error={payTried ? payDescError : null} onChange={(e) => setPayDesc(e.currentTarget.value)} />
          <Group grow>
            <NumberInput label="Valor (R$)" required {...MONEY_INPUT_BRL} clampBehavior="none" min={0.01} value={payAmount} error={payTried ? payAmountError : null} onChange={setPayAmount} />
            <Select
              label="Tipo"
              data={[
                { value: 'in', label: 'Entrada' },
                { value: 'out', label: 'Saída' },
              ]}
              value={payFlow}
              allowDeselect={false}
              // Situação options differ per direction, so reset it when Tipo changes.
              onChange={(v) => {
                const f = v ?? 'in';
                setPayFlow(f);
                setPayStatus(f === 'in' ? 'open' : 'upcoming');
              }}
            />
          </Group>
          <Select
            label="Categoria"
            placeholder="Selecione"
            required
            searchable
            data={categories
              .filter((cat) => !cat.flow || cat.flow === payFlow)
              .map((cat) => ({ value: String(cat.id), label: cat.name }))}
            value={payCat}
            onChange={setPayCat}
          />
          <Group grow>
            <Select
              label="Situação"
              data={
                payFlow === 'in'
                  ? [
                      { value: 'open', label: 'Aberto' },
                      { value: 'received', label: 'Recebido' },
                    ]
                  : [
                      { value: 'upcoming', label: 'A pagar' },
                      { value: 'done', label: 'Pago' },
                    ]
              }
              value={payStatus}
              allowDeselect={false}
              onChange={(v) => setPayStatus(v ?? (payFlow === 'in' ? 'open' : 'upcoming'))}
            />
            <DateField label="Vencimento" value={payDue} onChange={setPayDue} />
          </Group>
          <Text size="xs" c="dimmed">
            Entradas recebidas podem gerar recibo aqui e na tela Financeiro.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPayOpen(false)}>
              Cancelar
            </Button>
            <Button loading={addPayment.isPending} disabled={!payCat}
              onClick={() => {
                setPayTried(true);
                if (!payDescError && !payAmountError) addPayment.mutate();
              }}>
              Adicionar
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* mark receipt received modal */}
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

// One-time contract view: items + payments + documents.
function OneTimeView({
  c,
  onGenerate,
  generating,
  onDeleteDoc,
  onAddPayment,
  onEditPayment,
  onRemovePayment,
  onMarkReceived,
  onGenerateReceipt,
}: {
  c: CD;
  onGenerate: () => void;
  generating: boolean;
  onDeleteDoc: (id: number) => void;
  onAddPayment: () => void;
  onEditPayment: (p: Payment) => void;
  onRemovePayment: (id: number) => void;
  onMarkReceived: (p: Payment) => void;
  onGenerateReceipt: (id: number, format: 'docx' | 'pdf') => void;
}) {
  const isInstallment = (p: Payment) => !!p.installmentNumber;
  return (
    <>
      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Itens do contrato
        </Title>
        <Table.ScrollContainer minWidth={640}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Serviço</Table.Th>
                <Table.Th>Adicionais</Table.Th>
                <Table.Th ta="center">Desc.</Table.Th>
                <Table.Th ta="right">Valor</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {c.items.map((it) => (
                <Table.Tr key={it.id}>
                  <Table.Td>
                    {it.serviceName} {it.version ? <Badge size="xs" variant="light">v{it.version}</Badge> : null}
                  </Table.Td>
                  <Table.Td>
                    {it.additionals.length === 0
                      ? '—'
                      : it.additionals.map((a) => `${a.name} x${a.quantity}${Number(a.discountPercent) ? ` (-${Number(a.discountPercent)}%)` : ''}`).join(', ')}
                  </Table.Td>
                  <Table.Td ta="center">{Number(it.discountPercent) ? `${Number(it.discountPercent)}%` : '—'}</Table.Td>
                  <Table.Td ta="right">{brl(Number(it.lineTotal))}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {c.modifiers.length > 0 && (
          <>
            <Divider my="sm" label="Modificadores" />
            <Stack gap={2}>
              {c.modifiers.map((m) => (
                <Group key={m.id} justify="space-between">
                  <Text size="sm">{m.name}</Text>
                  <Text size="sm" c={Number(m.price) < 0 ? 'red' : undefined}>
                    {brl(Number(m.price))}
                  </Text>
                </Group>
              ))}
            </Stack>
          </>
        )}
        <Group justify="flex-end" mt="sm">
          <Text fw={700}>Total: {brl(Number(c.total))}</Text>
        </Group>
      </Paper>

      {/* Payments */}
      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Title order={4}>Pagamentos</Title>
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={onAddPayment}>
            Pagamento extra
          </Button>
        </Group>
        <Table.ScrollContainer minWidth={640}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Descrição</Table.Th>
                <Table.Th>Vencimento</Table.Th>
                <Table.Th ta="right">Valor</Table.Th>
                <Table.Th>Situação</Table.Th>
                <Table.Th ta="right" />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {c.payments.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text c="dimmed">Nenhum pagamento.</Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {c.payments.map((p) => (
                <Table.Tr key={p.id}>
                  <Table.Td>
                    {p.installmentNumber ? `Parcela ${p.installmentNumber}/${p.installmentCount}` : p.description}
                  </Table.Td>
                  <Table.Td>{formatBr(p.dueDate)}</Table.Td>
                  <Table.Td ta="right">{brl(Number(p.amount))}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      <Badge color={p.flow === 'in' ? 'green' : 'red'} variant="dot">
                        {p.flow === 'in' ? 'Entrada' : 'Saída'}
                      </Badge>
                      <Badge color={paymentSituation(p).color} variant="light">
                        {paymentSituation(p).label}
                      </Badge>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      {p.flow === 'in' && p.receiptStatus === 'open' && (
                        <Button size="compact-xs" variant="light" leftSection={<IconCheck size={14} />} onClick={() => onMarkReceived(p)}>
                          Marcar recebido
                        </Button>
                      )}
                      {p.flow === 'in' && p.receiptStatus !== 'open' && (
                        <>
                          <Button size="compact-xs" variant="light" leftSection={<IconFileText size={14} />} onClick={() => onGenerateReceipt(p.id, 'docx')}>
                            Baixar
                          </Button>
                          <Button size="compact-xs" variant="light" onClick={() => onGenerateReceipt(p.id, 'pdf')}>
                            PDF
                          </Button>
                        </>
                      )}
                      <ActionIcon size="sm" variant="subtle" title="Editar pagamento" onClick={() => onEditPayment(p)}>
                        <IconEdit size={14} />
                      </ActionIcon>
                      {!isInstallment(p) && (
                        <ActionIcon size="sm" variant="subtle" color="red" title="Remover pagamento" onClick={() => onRemovePayment(p.id)}>
                          <IconTrash size={14} />
                        </ActionIcon>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Documento
        </Title>
        <Group justify="flex-end">
          <Button
            leftSection={<IconFileText size={16} />}
            loading={generating}
            onClick={() => {
              if (
                c.documents.length > 0 &&
                !confirm(
                  'Já existe um documento gerado para este contrato. Gerar novamente irá substituir o arquivo existente. Deseja continuar?'
                )
              )
                return;
              onGenerate();
            }}
          >
            Gerar contrato
          </Button>
        </Group>
        <Divider my="sm" label="Histórico" />
        {c.documents.length === 0 && <Text c="dimmed" size="sm">Nenhum documento gerado.</Text>}
        {c.documents.map((d) => (
          <Group key={d.id} justify="space-between" mb={4}>
            <Text size="sm">
              {d.fileName}{' '}
              <Text span c="dimmed" size="xs">
                {new Date(d.generatedAt).toLocaleString('pt-BR')}
              </Text>
            </Text>
            <Group gap={4} wrap="nowrap">
              <Button
                size="compact-xs"
                variant="light"
                leftSection={<IconFileText size={14} />}
                onClick={() => downloadFile(`/api/contract-documents/${d.id}/download`, d.fileName)}
              >
                Baixar
              </Button>
              <Button
                size="compact-xs"
                variant="light"
                onClick={() =>
                  downloadFile(
                    `/api/contract-documents/${d.id}/pdf`,
                    d.fileName.replace(/\.(docx|odt)$/i, '') + '.pdf'
                  )
                }
              >
                PDF
              </Button>
              <ActionIcon size="sm" variant="subtle" color="red" title="Excluir documento" onClick={() => { if (confirm('Excluir este documento? O arquivo também será apagado.')) onDeleteDoc(d.id); }}>
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          </Group>
        ))}
      </Paper>
    </>
  );
}
