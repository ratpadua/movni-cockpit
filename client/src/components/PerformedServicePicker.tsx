import { Group, Text, Stack, Table, NumberInput, Textarea, Card } from '@mantine/core';
import { Select } from './Select';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ServiceCatalog, ServiceDetail, ServiceVersion } from '../api/client';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export interface PerformedAdditional {
  id: number;
  name: string;
  unitPrice: number;
  qty: number; // chosen quantity for this item (0 = not included)
}

// One performed-service item: always a single unit of the service, with its own
// description and its own additionals selection.
export interface PerformedItem {
  description: string;
  additionals: PerformedAdditional[];
}

export interface PerformedValue {
  serviceId: number | null;
  serviceVersionId: number | null;
  basePrice: number;
  items: PerformedItem[]; // one entry per unit (quantity = items.length)
}

export const emptyPerformed = (): PerformedValue => ({
  serviceId: null,
  serviceVersionId: null,
  basePrice: 0,
  items: [{ description: '', additionals: [] }],
});

export const performedItemTotal = (basePrice: number, it: PerformedItem): number =>
  basePrice + it.additionals.reduce((s, a) => s + a.unitPrice * a.qty, 0);

export const performedTotal = (v: PerformedValue): number =>
  v.items.reduce((s, it) => s + performedItemTotal(v.basePrice, it), 0);

// Selector for logging performed services on a recurring contract. A quantity > 1
// is NOT a single multi-quantity item: it produces that many separate items, each
// a single unit with its own description and additionals.
export default function PerformedServicePicker({
  value,
  onChange,
  lockQuantity = false,
}: {
  value: PerformedValue;
  onChange: (v: PerformedValue) => void;
  // When editing a single existing item, hide the quantity control (one item only).
  lockQuantity?: boolean;
}) {
  const qc = useQueryClient();
  const { data: catalog = [] } = useQuery({
    queryKey: ['/services'],
    queryFn: () => api.get<ServiceCatalog[]>('/services'),
  });

  const pickService = async (serviceId: string | null) => {
    if (!serviceId) return onChange(emptyPerformed());
    const detail = await qc.fetchQuery({
      queryKey: ['/services', Number(serviceId)],
      queryFn: () => api.get<ServiceDetail>(`/services/${serviceId}`),
    });
    const cur: ServiceVersion | undefined = detail.versions.find((v) => v.active) ?? detail.versions[0];
    const adds: PerformedAdditional[] = (cur?.additionals ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      unitPrice: Number(a.price),
      qty: 0,
    }));
    onChange({
      serviceId: Number(serviceId),
      serviceVersionId: cur?.id ?? null,
      basePrice: Number(cur?.basePrice ?? 0),
      items: [{ description: '', additionals: adds.map((a) => ({ ...a })) }],
    });
  };

  // A blank additionals template (all quantities 0) for newly added items.
  const additionalsTemplate = (): PerformedAdditional[] =>
    (value.items[0]?.additionals ?? []).map((a) => ({ ...a, qty: 0 }));

  const setQuantity = (n: number) => {
    const q = Math.max(1, Math.floor(Number(n) || 1));
    const next = value.items.slice(0, q);
    while (next.length < q) next.push({ description: '', additionals: additionalsTemplate() });
    onChange({ ...value, items: next });
  };

  const setItemDesc = (i: number, description: string) =>
    onChange({ ...value, items: value.items.map((it, idx) => (idx === i ? { ...it, description } : it)) });

  const setItemAddQty = (i: number, ai: number, qty: number) =>
    onChange({
      ...value,
      items: value.items.map((it, idx) =>
        idx === i
          ? { ...it, additionals: it.additionals.map((a, aidx) => (aidx === ai ? { ...a, qty: Math.max(0, qty) } : a)) }
          : it
      ),
    });

  const multiple = value.items.length > 1;

  return (
    <Stack gap="sm">
      <Group grow align="flex-end">
        <Select
          label="Serviço"
          placeholder="Selecione"
          data={catalog.map((s) => ({ value: String(s.id), label: s.name }))}
          value={value.serviceId != null ? String(value.serviceId) : null}
          onChange={pickService}
          searchable
        />
        {!lockQuantity && (
          <NumberInput
            label="Quantidade"
            description="Cada unidade vira um item próprio"
            min={1}
            value={value.items.length}
            onChange={(v) => setQuantity(Number(v) || 1)}
            disabled={!value.serviceVersionId}
          />
        )}
      </Group>

      {value.serviceVersionId &&
        value.items.map((it, i) => (
          <Card key={i} withBorder padding="sm" radius="md">
            {multiple && (
              <Text size="sm" fw={600} mb={4}>
                Item {i + 1}
              </Text>
            )}
            <Textarea
              label="Descrição"
              value={it.description}
              onChange={(e) => setItemDesc(i, e.currentTarget.value)}
              autosize
              minRows={1}
            />
            {it.additionals.length > 0 && (
              <Table.ScrollContainer minWidth={640}>
                <Table mt="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Adicional</Table.Th>
                      <Table.Th>Unitário</Table.Th>
                      <Table.Th>Qtd.</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {it.additionals.map((a, ai) => (
                      <Table.Tr key={a.id}>
                        <Table.Td>{a.name}</Table.Td>
                        <Table.Td>{brl(a.unitPrice)}</Table.Td>
                        <Table.Td>
                          <NumberInput w={80} min={0} value={a.qty} onChange={(v) => setItemAddQty(i, ai, Number(v) || 0)} />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
            <Text size="xs" c="dimmed" mt={4}>
              Total do item: <b>{brl(performedItemTotal(value.basePrice, it))}</b>
            </Text>
          </Card>
        ))}

      {value.serviceVersionId && multiple && (
        <Text size="sm">
          Total ({value.items.length} itens): <b>{brl(performedTotal(value))}</b>
        </Text>
      )}
    </Stack>
  );
}
