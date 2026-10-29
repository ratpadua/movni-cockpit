import { useEffect, useState } from 'react';
import {
  Modal,
  Stack,
  Group,
  TextInput,
  Textarea,
  NumberInput,
  Button,
  Text,
  Divider,
  Table,
  ActionIcon,
  Alert,
  Paper,
} from '@mantine/core';
import { Select } from './Select';
import DateField from './DateField';
import { IconPlus, IconTrash, IconInfoCircle } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import {
  api,
  Customer,
  CustomerCredit,
  TemplateInfo,
  ServiceCatalog,
  ServiceDetail,
  ContractDetail,
} from '../api/client';
import InstallmentPlanner, { InstallmentValue } from './InstallmentPlanner';
import { todayIso } from '../lib/dates';
import { MONEY_INPUT_BRL } from '../lib/money';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface AddRow {
  id: number;
  name: string;
  unitPrice: number;
  qty: number;
  disc: number;
}
interface ModRow {
  name: string;
  price: number | string;
  disc: number | string;
}

export default function ContractFormModal({
  opened,
  editingId,
  onClose,
  onSaved,
}: {
  opened: boolean;
  editingId: number | null;
  onClose: () => void;
  onSaved: (contractId: number, type: string) => void;
}) {
  const qc = useQueryClient();
  const { data: customers = [] } = useQuery({ queryKey: ['/customers'], queryFn: () => api.get<Customer[]>('/customers') });
  const { data: templates = [] } = useQuery({ queryKey: ['/templates'], queryFn: () => api.get<TemplateInfo[]>('/templates') });
  const { data: catalog = [] } = useQuery({ queryKey: ['/services'], queryFn: () => api.get<ServiceCatalog[]>('/services') });

  const [type, setType] = useState<'contract' | 'invoice'>('contract');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [creditId, setCreditId] = useState<string | null>(null);
  const [comments, setComments] = useState('');
  // recurring
  const [title, setTitle] = useState('');
  const [invoiceTemplateId, setInvoiceTemplateId] = useState<string | null>(null);
  // receipts for this contract's payments (both contract types)
  const [receiptTemplateId, setReceiptTemplateId] = useState<string | null>(null);
  // one-time
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [serviceVersionId, setServiceVersionId] = useState<number | null>(null);
  const [basePrice, setBasePrice] = useState(0);
  const [serviceDisc, setServiceDisc] = useState<number | string>(0);
  const [quantity, setQuantity] = useState<number | string>(1);
  const [duration, setDuration] = useState('');
  const [additionals, setAdditionals] = useState<AddRow[]>([]);
  const [modifiers, setModifiers] = useState<ModRow[]>([]);
  const [execDate, setExecDate] = useState('');
  const [execTime, setExecTime] = useState('');
  const [execAddress, setExecAddress] = useState('');
  const [plan, setPlan] = useState<InstallmentValue>({ count: 1, dueDates: [todayIso()] });

  const { data: credits = [] } = useQuery({
    queryKey: ['/customers', customerId, 'credits'],
    queryFn: () => api.get<CustomerCredit[]>(`/customers/${customerId}/credits`),
    enabled: !!customerId,
  });

  const tplOptions = (kind: 'contract' | 'invoice' | 'receipt') =>
    templates.filter((t) => t.kind === kind).map((t) => ({ value: String(t.id), label: t.name }));
  // The receipt model is mandatory; when there is exactly one it is used by default.
  const receiptOptions = tplOptions('receipt');
  const effectiveReceiptId = receiptTemplateId ?? (receiptOptions.length === 1 ? receiptOptions[0].value : null);

  // Load a service version's additionals (by version id, else current).
  const loadServiceAdds = async (svcId: number, versionId?: number | null) => {
    const detail = await qc.fetchQuery({ queryKey: ['/services', svcId], queryFn: () => api.get<ServiceDetail>(`/services/${svcId}`) });
    const version = versionId ? detail.versions.find((v) => v.id === versionId) : detail.versions.find((v) => v.active) ?? detail.versions[0];
    return { detail, version };
  };

  const resetCreate = () => {
    setType('contract');
    setCustomerId(null);
    setCreditId(null);
    setComments('');
    setTitle('');
    setInvoiceTemplateId(null);
    setReceiptTemplateId(null);
    setTemplateId(null);
    setServiceId(null);
    setServiceVersionId(null);
    setBasePrice(0);
    setServiceDisc(0);
    setQuantity('');
    setDuration('');
    setAdditionals([]);
    setModifiers([]);
    setExecDate('');
    setExecTime('');
    setExecAddress('');
    setPlan({ count: 1, dueDates: [todayIso()] });
  };

  const loadForEdit = async (id: number) => {
    const d = await api.get<ContractDetail>(`/contracts/${id}`);
    setType(d.type);
    setCustomerId(d.customerId != null ? String(d.customerId) : null);
    setCreditId(null); // credit is applied only at creation
    setComments(d.comments ?? '');
    setTitle(d.title ?? '');
    setInvoiceTemplateId(d.invoiceTemplateId != null ? String(d.invoiceTemplateId) : null);
    setReceiptTemplateId(d.receiptTemplateId != null ? String(d.receiptTemplateId) : null);
    setTemplateId(d.templateId != null ? String(d.templateId) : null);
    setExecDate(d.executionDate ?? '');
    setExecTime(d.executionTime ?? '');
    setExecAddress(d.executionAddress ?? '');
    setDuration(d.duration ?? '');
    setQuantity(d.quantity ?? '');
    setModifiers(d.modifiers.map((m) => ({ name: m.name, price: Number(m.price), disc: Number(m.discountPercent) || 0 })));
    const dueDates = d.payments.filter((p) => p.installmentNumber).map((p) => p.dueDate ?? todayIso());
    setPlan({ count: d.installments || dueDates.length || 1, dueDates: dueDates.length ? dueDates : [todayIso()] });

    const item = d.items[0];
    if (d.type === 'contract' && item && item.serviceId) {
      setServiceId(String(item.serviceId));
      setServiceVersionId(item.serviceVersionId ?? null);
      setServiceDisc(Number(item.discountPercent) || 0);
      const { version } = await loadServiceAdds(item.serviceId, item.serviceVersionId);
      setBasePrice(Number(version?.basePrice ?? item.basePrice));
      const chosen = new Map(item.additionals.map((a) => [a.additionalId ?? -1, a]));
      const rows: AddRow[] = (version?.additionals ?? []).map((a) => {
        const c = chosen.get(a.id);
        return { id: a.id, name: a.name, unitPrice: Number(a.price), qty: c ? c.quantity : 0, disc: c ? Number(c.discountPercent) : 0 };
      });
      setAdditionals(rows);
    } else {
      setServiceId(null);
      setServiceVersionId(null);
      setAdditionals([]);
    }
  };

  useEffect(() => {
    if (!opened) return;
    if (editingId) loadForEdit(editingId);
    else resetCreate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, editingId]);

  const pickService = async (svcId: string | null) => {
    if (!svcId) {
      setServiceId(null);
      setServiceVersionId(null);
      setAdditionals([]);
      setBasePrice(0);
      return;
    }
    const { version } = await loadServiceAdds(Number(svcId));
    setServiceId(svcId);
    setServiceVersionId(version?.id ?? null);
    setBasePrice(Number(version?.basePrice ?? 0));
    setServiceDisc(0);
    setAdditionals((version?.additionals ?? []).map((a) => ({ id: a.id, name: a.name, unitPrice: Number(a.price), qty: 0, disc: 0 })));
  };

  const setAdd = (i: number, patch: Partial<AddRow>) =>
    setAdditionals((arr) => arr.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));

  const serviceLine = Math.max(0, basePrice * (1 - (Number(serviceDisc) || 0) / 100));
  const addTotal = additionals
    .filter((a) => a.qty > 0)
    .reduce((s, a) => s + a.unitPrice * a.qty * (1 - (a.disc || 0) / 100), 0);
  const modTotal = modifiers.reduce((s, m) => s + (Number(m.price) || 0) * (1 - (Number(m.disc) || 0) / 100), 0);
  const total = Math.max(0, serviceLine + addTotal + modTotal);

  // Prepaid credit reduces the amount split into installments (create only).
  const selCredit = credits.find((c) => String(c.id) === creditId);
  const creditApplied = selCredit ? Math.min(Number(selCredit.remaining), total) : 0;
  const baseAfterCredit = Math.max(0, total - creditApplied);

  const isRecurring = type === 'invoice';

  const save = useMutation({
    mutationFn: () => {
      if (isRecurring) {
        const payload: any = {
          customerId: customerId ? Number(customerId) : null,
          type: 'invoice',
          title,
          comments,
          invoiceTemplateId: invoiceTemplateId ? Number(invoiceTemplateId) : null,
          receiptTemplateId: effectiveReceiptId ? Number(effectiveReceiptId) : null,
        };
        return editingId ? api.put(`/contracts/${editingId}`, payload) : api.post('/contracts', payload);
      }
      const payload: any = {
        customerId: customerId ? Number(customerId) : null,
        type: 'contract',
        comments,
        templateId: templateId ? Number(templateId) : null,
        receiptTemplateId: effectiveReceiptId ? Number(effectiveReceiptId) : null,
        executionDate: execDate || null,
        executionTime: execTime || null,
        executionAddress: execAddress || null,
        duration: duration || null,
        quantity: quantity === '' || quantity == null ? null : Number(quantity),
        creditId: creditId ? Number(creditId) : null,
        installments: plan.count,
        dueDates: plan.dueDates,
        items: serviceVersionId
          ? [
              {
                serviceVersionId,
                quantity: 1,
                discountPercent: Number(serviceDisc) || 0,
                additionals: additionals
                  .filter((a) => a.qty > 0)
                  .map((a) => ({ additionalId: a.id, quantity: a.qty, discountPercent: a.disc })),
              },
            ]
          : [],
        modifiers: modifiers
          .filter((m) => m.name)
          .map((m) => ({ name: m.name, price: Number(m.price) || 0, discountPercent: Number(m.disc) || 0 })),
      };
      return editingId ? api.put(`/contracts/${editingId}`, payload) : api.post('/contracts', payload);
    },
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['/contracts'] });
      if (editingId) qc.invalidateQueries({ queryKey: ['/contracts', editingId, 'detail'] });
      notifications.show({ message: 'Contrato salvo', color: 'green' });
      onClose();
      onSaved(res?.id ?? editingId, res?.type ?? type);
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const serviceOptions = catalog.map((s) => ({ value: String(s.id), label: s.name }));

  return (
    <Modal opened={opened} onClose={onClose} title={editingId ? `Editar contrato #${editingId}` : 'Novo contrato'} size="xl">
      <Stack>
        <Group grow>
          <Select label="Cliente" placeholder="Selecione" data={customers.map((c) => ({ value: String(c.id), label: c.name }))} value={customerId} onChange={(v) => { setCustomerId(v); setCreditId(null); }} searchable required />
          <Select
            label="Tipo"
            data={[
              { value: 'contract', label: 'Contrato (único)' },
              { value: 'invoice', label: 'Fatura (recorrente)' },
            ]}
            value={type}
            onChange={(v) => setType((v as any) ?? 'contract')}
            disabled={editingId != null}
          />
        </Group>

        {isRecurring ? (
          <>
            <TextInput label="Título" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
            <Select label="Modelo da fatura" placeholder="Selecione um modelo" data={tplOptions('invoice')} value={invoiceTemplateId} onChange={setInvoiceTemplateId} required searchable nothingFoundMessage="Nenhum modelo de fatura enviado" />
            <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
              Os serviços realizados são adicionados depois, na tela do contrato, e faturados quando quiser.
            </Alert>
          </>
        ) : (
          <>
            <Group grow>
              <Select label="Serviço (título do contrato)" placeholder="Selecione o serviço" data={serviceOptions} value={serviceId} onChange={pickService} searchable required />
              <Select label="Modelo do documento" placeholder="Selecione um modelo" data={tplOptions('contract')} value={templateId} onChange={setTemplateId} required searchable nothingFoundMessage="Nenhum modelo de contrato enviado" />
            </Group>

            <Group grow>
              <DateField label="Data" value={execDate} onChange={setExecDate} clearable />
              <TextInput type="time" label="Horário" value={execTime} onChange={(e) => setExecTime(e.currentTarget.value)} />
            </Group>
            <TextInput label="Locação" placeholder="Onde o serviço será executado" value={execAddress} onChange={(e) => setExecAddress(e.currentTarget.value)} />
            <Group grow>
              <TextInput label="Duração" placeholder='Ex.: "2 horas", "3 meses"' value={duration} onChange={(e) => setDuration(e.currentTarget.value)} />
              <NumberInput
                label="Quantidade"
                placeholder="Ex.: 20"
                min={1}
                value={quantity}
                onChange={setQuantity}
              />
            </Group>

            {serviceId && (
              <Paper withBorder p="sm" radius="md">
                <Group justify="space-between">
                  <Text fw={500}>Preço base: {brl(basePrice)}</Text>
                  <NumberInput label="Desconto do serviço (%)" w={180} min={0} max={100} suffix="%" value={serviceDisc} onChange={setServiceDisc} />
                </Group>

                {additionals.length > 0 && (
                  <>
                    <Divider my="sm" label="Adicionais" />
                    <Table>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Adicional</Table.Th>
                          <Table.Th>Unitário</Table.Th>
                          <Table.Th>Qtd.</Table.Th>
                          <Table.Th>Desc. %</Table.Th>
                          <Table.Th ta="right">Total</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {additionals.map((a, i) => (
                          <Table.Tr key={a.id}>
                            <Table.Td>{a.name}</Table.Td>
                            <Table.Td>{brl(a.unitPrice)}</Table.Td>
                            <Table.Td>
                              <NumberInput w={80} min={0} value={a.qty} onChange={(v) => setAdd(i, { qty: Math.max(0, Number(v) || 0) })} />
                            </Table.Td>
                            <Table.Td>
                              <NumberInput w={80} min={0} max={100} value={a.disc} onChange={(v) => setAdd(i, { disc: Math.max(0, Number(v) || 0) })} />
                            </Table.Td>
                            <Table.Td ta="right">{brl(a.qty > 0 ? a.unitPrice * a.qty * (1 - (a.disc || 0) / 100) : 0)}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </>
                )}
              </Paper>
            )}

            {/* Contract-level custom modifiers */}
            <Paper withBorder p="sm" radius="md">
              <Group justify="space-between" mb="xs">
                <Text fw={500} size="sm">
                  Modificadores
                </Text>
                <Button size="compact-xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setModifiers((m) => [...m, { name: '', price: 0, disc: 0 }])}>
                  Adicionar
                </Button>
              </Group>
              {modifiers.length === 0 && (
                <Text size="xs" c="dimmed">
                  Nenhum modificador.
                </Text>
              )}
              {modifiers.map((m, i) => (
                <Group key={i} gap="xs" wrap="nowrap" mb={4}>
                  <TextInput placeholder="Descrição" value={m.name} onChange={(e) => setModifiers((arr) => arr.map((x, idx) => (idx === i ? { ...x, name: e.currentTarget.value } : x)))} style={{ flex: 1 }} />
                  <NumberInput placeholder="Valor" {...MONEY_INPUT_BRL} w={130} value={m.price} onChange={(v) => setModifiers((arr) => arr.map((x, idx) => (idx === i ? { ...x, price: v } : x)))} />
                  <NumberInput placeholder="Desc." suffix="%" min={0} max={100} w={90} value={m.disc} onChange={(v) => setModifiers((arr) => arr.map((x, idx) => (idx === i ? { ...x, disc: v } : x)))} />
                  <ActionIcon color="red" variant="subtle" onClick={() => setModifiers((arr) => arr.filter((_, idx) => idx !== i))}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              ))}
            </Paper>

            <Group justify="flex-end" gap="xl">
              <Text size="sm" c="dimmed">Serviço: {brl(serviceLine)} · Adicionais: {brl(addTotal)} · Modificadores: {brl(modTotal)}</Text>
            </Group>

            {!editingId && credits.length > 0 && (
              <Select
                label="Usar crédito do cliente"
                placeholder="Nenhum"
                clearable
                searchable
                data={credits.map((c) => ({
                  value: String(c.id),
                  label: `${c.description} — restante ${brl(Number(c.remaining))}`,
                }))}
                value={creditId}
                onChange={setCreditId}
                description={
                  creditApplied > 0
                    ? `${brl(creditApplied)} abatido com crédito · a parcelar: ${brl(baseAfterCredit)}`
                    : undefined
                }
              />
            )}

            <Divider label="Parcelamento" />
            <InstallmentPlanner amount={baseAfterCredit} value={plan} onChange={setPlan} />
          </>
        )}

        <Select
          label="Modelo do recibo"
          description="Modelo usado nos recibos dos pagamentos deste contrato."
          placeholder="Selecione um modelo"
          data={receiptOptions}
          value={effectiveReceiptId}
          onChange={setReceiptTemplateId}
          required
          searchable
          nothingFoundMessage="Nenhum modelo de recibo enviado"
        />

        <Textarea label="Comentários" description="Usado no documento gerado." value={comments} onChange={(e) => setComments(e.currentTarget.value)} autosize minRows={2} />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={save.isPending}
            disabled={
              !customerId ||
              !effectiveReceiptId ||
              (isRecurring ? !invoiceTemplateId : !serviceVersionId || !templateId)
            }
            onClick={() => save.mutate()}
          >
            Salvar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
