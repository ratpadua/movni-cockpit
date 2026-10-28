import { useMemo, useState } from 'react';
import {
  Stack,
  Title,
  Group,
  Button,
  Paper,
  Table,
  Text,
  FileButton,
  Checkbox,
  TextInput,
  NumberInput,
  Alert,
  Badge,
  Tooltip,
} from '@mantine/core';
import { Select } from '../components/Select';
import { IconUpload, IconDatabaseImport, IconInfoCircle } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, Category, PreviewItem, OpenPaymentOption, ParsePreview, ContractSummary } from '../api/client';
import DateField from '../components/DateField';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// OFX files vary in encoding: Banco do Brasil emits UTF-8, others use
// ISO-8859-1/Windows-1252. Decode as UTF-8 when the bytes are valid UTF-8,
// otherwise fall back to Windows-1252 (a superset of latin1) so BR accents
// (ç, ã, é, …) come through intact instead of as mojibake.
function decodeOfx(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export default function BankImport() {
  const qc = useQueryClient();
  const [fileName, setFileName] = useState('');
  const [meta, setMeta] = useState<{ bankId: string | null; accountId: string | null }>({
    bankId: null,
    accountId: null,
  });
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [openPayments, setOpenPayments] = useState<OpenPaymentOption[]>([]);

  const { data: categories = [] } = useQuery({
    queryKey: ['/categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });
  const { data: contracts = [] } = useQuery({
    queryKey: ['/contracts'],
    queryFn: () => api.get<ContractSummary[]>('/contracts'),
  });

  const categoryOptions = categories.map((c) => ({ value: String(c.id), label: c.name }));
  const contractOptions = contracts.map((ct) => ({
    value: String(ct.id),
    label: `${ct.number ?? `#${ct.id}`}${ct.customerName ? ` — ${ct.customerName}` : ''}`,
  }));

  const parse = useMutation({
    mutationFn: (content: string) => api.post<ParsePreview>('/bank/parse', { fileName, content }),
    onSuccess: (res) => {
      setMeta({ bankId: res.bankId, accountId: res.accountId });
      setItems(res.items);
      setOpenPayments(res.openPayments);
      notifications.show({ message: `${res.items.length} lançamentos lidos`, color: 'blue' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const doImport = useMutation({
    mutationFn: () => {
      const selected = items.filter((i) => i.selected);
      // A payment associated to a contract (extra) must always have a category.
      if (selected.some((i) => i.contractId && i.categoryId == null)) {
        return Promise.reject(new Error('Selecione uma categoria para os lançamentos associados a um contrato.'));
      }
      return api.post<{ received: number; created: number; imported: number }>('/bank/import', {
        items: selected,
        // Recorded with the import so these lines are flagged next time.
        fileName,
        bankId: meta.bankId,
        accountId: meta.accountId,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['/payments'] });
      notifications.show({
        message: `${res.received} conciliado(s) · ${res.created} criado(s)`,
        color: 'green',
      });
      setItems([]);
      setOpenPayments([]);
      setFileName('');
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const onFile = (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => parse.mutate(decodeOfx(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file); // decode by sniffing UTF-8 vs Windows-1252
  };

  const update = (idx: number, patch: Partial<PreviewItem>) =>
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  // "Select all" covers only new lines: lines imported before stay unticked unless
  // the user ticks them one by one.
  const newItems = items.filter((i) => !i.alreadyImported);
  const allSelected = newItems.length > 0 && newItems.every((i) => i.selected);
  const selectedCount = items.filter((i) => i.selected).length;
  const alreadyCount = items.length - newItems.length;

  // Grouped options for the Referência column: an item's own suggestions first,
  // then every other open receivable (searchable by customer / contract).
  const referenceData = useMemo(
    () => (it: PreviewItem) => {
      const sugIds = new Set(it.suggestions.map((s) => String(s.paymentId)));
      const groups: { group: string; items: { value: string; label: string }[] }[] = [];
      if (it.suggestions.length > 0) {
        groups.push({
          group: 'Sugestões',
          items: it.suggestions.map((s) => ({
            value: String(s.paymentId),
            label: `${s.label} · ${s.reason}`,
          })),
        });
      }
      const rest = openPayments.filter((o) => !sugIds.has(o.value));
      if (rest.length > 0) groups.push({ group: 'Abertos', items: rest });
      return groups;
    },
    [openPayments]
  );

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Extratos bancários</Title>
        <Group>
          <FileButton onChange={onFile} accept=".ofx,.OFX">
            {(props) => (
              <Button {...props} variant="default" leftSection={<IconUpload size={16} />} loading={parse.isPending}>
                Carregar OFX
              </Button>
            )}
          </FileButton>
          <Button
            leftSection={<IconDatabaseImport size={16} />}
            disabled={selectedCount === 0}
            loading={doImport.isPending}
            onClick={() => doImport.mutate()}
          >
            Importar selecionados ({selectedCount})
          </Button>
        </Group>
      </Group>

      {items.length === 0 && (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
          Carregue um arquivo <b>.OFX</b>. Os lançamentos aparecem aqui para revisão — valores em{' '}
          <Text span c="teal.7" fw={600}>
            verde
          </Text>{' '}
          são receitas e em{' '}
          <Text span c="red.7" fw={600}>
            vermelho
          </Text>{' '}
          são custos. Em <b>Referência</b>, escolha o pagamento a conciliar (será marcado como
          recebido); se deixar em branco, um novo lançamento é criado ao importar.
        </Alert>
      )}

      {items.length > 0 && (
        <>
          {fileName && (
            <Text size="sm" c="dimmed">
              Arquivo: <b>{fileName}</b>
              {meta.bankId ? ` · Banco ${meta.bankId}` : ''}
              {meta.accountId ? ` · Conta ${meta.accountId}` : ''}
            </Text>
          )}
          {alreadyCount > 0 && (
            <Alert icon={<IconInfoCircle size={16} />} color="yellow" variant="light">
              {alreadyCount === 1
                ? '1 lançamento deste extrato já foi importado antes'
                : `${alreadyCount} lançamentos deste extrato já foram importados antes`}{' '}
              e {alreadyCount === 1 ? 'veio desmarcado' : 'vieram desmarcados'}. Marque a linha se quiser importar de novo.
            </Alert>
          )}
          <Paper withBorder radius="md" style={{ overflowX: 'auto' }}>
            <Table striped highlightOnHover miw={1000}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={{ width: 36 }}>
                    <Checkbox
                      checked={allSelected}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setItems((arr) => arr.map((it) => (it.alreadyImported ? it : { ...it, selected: on })));
                      }}
                    />
                  </Table.Th>
                  <Table.Th>Data</Table.Th>
                  <Table.Th>Tipo</Table.Th>
                  <Table.Th>Descrição</Table.Th>
                  <Table.Th>Valor</Table.Th>
                  <Table.Th>Categoria</Table.Th>
                  <Table.Th>Referência</Table.Th>
                  <Table.Th>Contrato (extra)</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((it, idx) => {
                  const isIn = it.amount >= 0;
                  const valueColor = isIn ? 'var(--mantine-color-teal-7)' : 'var(--mantine-color-red-7)';
                  return (
                    <Table.Tr
                      key={idx}
                      // Lines imported before are tinted and unticked by default.
                      style={it.alreadyImported ? { backgroundColor: 'var(--mantine-color-yellow-light)' } : undefined}
                    >
                      <Table.Td>
                        <Checkbox
                          checked={it.selected}
                          onChange={(e) => update(idx, { selected: e.currentTarget.checked })}
                        />
                      </Table.Td>
                      <Table.Td>
                        <DateField
                          size="xs"
                          w={140}
                          value={it.date ?? ''}
                          onChange={(v) => update(idx, { date: v })}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                          {it.type || '—'}
                        </Text>
                        {it.alreadyImported && (
                          <Tooltip label="Esta linha já foi importada antes. Marque a caixa para importar de novo.">
                            <Badge color="yellow" variant="filled" size="sm" mt={4}>
                              Já importado
                            </Badge>
                          </Tooltip>
                        )}
                      </Table.Td>
                      <Table.Td miw={220}>
                        <TextInput
                          size="xs"
                          value={it.description}
                          onChange={(e) => update(idx, { description: e.currentTarget.value })}
                        />
                      </Table.Td>
                      <Table.Td>
                        <NumberInput
                          size="xs"
                          w={120}
                          decimalScale={2}
                          value={it.amount}
                          onChange={(v) => {
                            const n = Number(v);
                            update(idx, { amount: n, flow: n < 0 ? 'out' : 'in' });
                          }}
                          styles={{ input: { color: valueColor, fontWeight: 600 } }}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Select
                          size="xs"
                          w={160}
                          placeholder="Categoria"
                          data={categoryOptions}
                          value={it.categoryId != null ? String(it.categoryId) : null}
                          onChange={(v) => update(idx, { categoryId: v ? Number(v) : null })}
                          searchable
                          clearable
                        />
                      </Table.Td>
                      <Table.Td>
                        {isIn ? (
                          <Select
                            size="xs"
                            w={280}
                            placeholder="Novo lançamento"
                            data={referenceData(it)}
                            value={it.matchedPaymentId != null ? String(it.matchedPaymentId) : null}
                            // Reconciling an installment and an extra are mutually exclusive.
                            onChange={(v) => update(idx, { matchedPaymentId: v ? Number(v) : null, contractId: v ? null : it.contractId })}
                            searchable
                            clearable
                            disabled={it.contractId != null}
                            nothingFoundMessage="Nenhum pagamento aberto"
                          />
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {isIn ? (
                          <Select
                            size="xs"
                            w={240}
                            placeholder="Nenhum"
                            data={contractOptions}
                            value={it.contractId != null ? String(it.contractId) : null}
                            // Extra payment: clears any Referência match.
                            onChange={(v) => update(idx, { contractId: v ? Number(v) : null, matchedPaymentId: v ? null : it.matchedPaymentId })}
                            searchable
                            clearable
                            disabled={it.matchedPaymentId != null}
                            error={it.contractId != null && it.categoryId == null ? 'Categoria obrigatória' : undefined}
                          />
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Paper>
        </>
      )}
    </Stack>
  );
}
