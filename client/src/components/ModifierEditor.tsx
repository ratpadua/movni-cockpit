import { ActionIcon, Button, Group, NumberInput, Stack, Text, TextInput } from '@mantine/core';
import { MONEY_INPUT_BRL } from '../lib/money';
import { IconPlus, IconTrash } from '@tabler/icons-react';

export interface AdditionalDraft {
  name: string;
  price: number | string;
}

// Editable list of a service's additionals (name + unit price) used when
// creating a service or a new version of a service.
export default function AdditionalEditor({
  value,
  onChange,
}: {
  value: AdditionalDraft[];
  onChange: (v: AdditionalDraft[]) => void;
}) {
  const update = (i: number, patch: Partial<AdditionalDraft>) =>
    onChange(value.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  const add = () => onChange([...value, { name: '', price: 0 }]);
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="sm" fw={500}>
          Adicionais
        </Text>
        <Button size="compact-xs" variant="light" leftSection={<IconPlus size={14} />} onClick={add}>
          Adicionar
        </Button>
      </Group>
      {value.length === 0 && (
        <Text size="xs" c="dimmed">
          Nenhum adicional.
        </Text>
      )}
      {value.map((m, i) => (
        <Group key={i} gap="xs" wrap="nowrap">
          <TextInput
            placeholder="Nome do adicional"
            value={m.name}
            onChange={(e) => update(i, { name: e.currentTarget.value })}
            style={{ flex: 1 }}
          />
          <NumberInput
            placeholder="Preço"
            {...MONEY_INPUT_BRL}
            w={130}
            value={m.price}
            onChange={(v) => update(i, { price: v })}
          />
          <ActionIcon color="red" variant="subtle" onClick={() => remove(i)}>
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
    </Stack>
  );
}
