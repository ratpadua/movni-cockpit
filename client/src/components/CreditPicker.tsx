import { Checkbox, Group, NumberInput, Paper, Stack, Text } from '@mantine/core';
import { AppliedCredit, CustomerCredit } from '../api/client';
import { MONEY_INPUT_BRL } from '../lib/money';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const round2 = (n: number) => Math.round(n * 100) / 100;

// The ticked credits: creditId -> amount to use (number, or '' while the field is empty).
export type CreditSelection = Record<number, number | string>;

// Credits already applied to the record being edited -> initial selection.
export function selectionFromApplied(applied: AppliedCredit[] | undefined): CreditSelection {
  const sel: CreditSelection = {};
  for (const a of applied ?? []) sel[a.creditId] = Number(a.amount);
  return sel;
}

// API payload: credits: [{ creditId, amount }] (stable order: by credit id).
export function creditsPayload(sel: CreditSelection): { creditId: number; amount: number }[] {
  return Object.keys(sel)
    .map(Number)
    .sort((a, b) => a - b)
    .map((id) => ({ creditId: id, amount: round2(Number(sel[id]) || 0) }));
}

export const creditsTotal = (sel: CreditSelection) =>
  round2(Object.values(sel).reduce<number>((s, v) => s + (Number(v) || 0), 0));

// What the record can still draw from a credit: what is left + what THIS record already consumed
// (the server reinstates the old applications before re-applying on edit).
function availableOf(cr: CustomerCredit, applied: AppliedCredit[]) {
  const mine = applied.filter((a) => a.creditId === cr.id).reduce((s, a) => s + Number(a.amount), 0);
  return round2(Number(cr.remaining) + mine);
}

// Credits shown in the list, oldest first: those with balance, plus the ones this record uses.
export function listableCredits(credits: CustomerCredit[], applied: AppliedCredit[]) {
  const used = new Set(applied.map((a) => a.creditId));
  return credits
    .filter((cr) => Number(cr.remaining) > 0 || used.has(cr.id))
    .sort((a, b) => a.id - b.id);
}

// Inline validation (pt-BR). `rows` has a message per ticked credit with a problem; `overall` is set
// when the credits together exceed the amount to cover. `ok` = nothing wrong.
export function validateCredits(
  sel: CreditSelection,
  credits: CustomerCredit[],
  applied: AppliedCredit[],
  total: number
): { rows: Record<number, string>; overall: string | null; ok: boolean } {
  const rows: Record<number, string> = {};
  for (const key of Object.keys(sel)) {
    const id = Number(key);
    const raw = sel[id];
    const amount = Number(raw);
    const cr = credits.find((c) => c.id === id);
    if (raw === '' || !(amount > 0)) rows[id] = 'Informe um valor maior que zero.';
    else if (!cr) rows[id] = 'Crédito não encontrado.';
    else if (amount > availableOf(cr, applied) + 0.004) rows[id] = `Máximo disponível: ${brl(availableOf(cr, applied))}.`;
  }
  const sum = creditsTotal(sel);
  const overall = sum > round2(total) + 0.004 ? `O total dos créditos (${brl(sum)}) excede o valor a ser coberto (${brl(total)}).` : null;
  return { rows, overall, ok: Object.keys(rows).length === 0 && overall === null };
}

// Multi-select of a customer's credits with an editable amount per credit.
// Used by the one-time contract form and by the new/edit fatura modals.
export default function CreditPicker({
  credits,
  applied = [],
  total,
  value,
  onChange,
  disabled = false,
}: {
  credits: CustomerCredit[]; // all of the customer's credits (fully used ones too, when editing)
  applied?: AppliedCredit[]; // credits already applied to the record being edited
  total: number; // amount to be covered (total after discounts/modifiers)
  value: CreditSelection;
  onChange: (v: CreditSelection) => void;
  disabled?: boolean;
}) {
  const list = listableCredits(credits, applied);
  if (list.length === 0) return null;

  const { rows, overall } = validateCredits(value, credits, applied, total);
  const sum = creditsTotal(value);
  const toSplit = Math.max(0, round2(total - sum));

  const toggle = (cr: CustomerCredit, on: boolean) => {
    const next = { ...value };
    if (on) {
      // Default: as much as possible, up to what is still uncovered.
      const others = creditsTotal(value);
      next[cr.id] = Math.max(0, round2(Math.min(availableOf(cr, applied), total - others)));
    } else {
      delete next[cr.id];
    }
    onChange(next);
  };

  return (
    <Paper withBorder p="sm" radius="md">
      <Text fw={500} size="sm" mb={4}>
        Usar créditos do cliente
      </Text>
      <Stack gap="xs">
        {list.map((cr) => {
          const checked = cr.id in value;
          const available = availableOf(cr, applied);
          return (
            <div key={cr.id}>
              <Group gap="sm" align="center" wrap="wrap" justify="space-between">
                <Checkbox
                  style={{ flex: '1 1 220px', minWidth: 0 }}
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => toggle(cr, e.currentTarget.checked)}
                  label={cr.description}
                  description={`Disponível ${brl(available)}`}
                />
                {checked && (
                  <NumberInput
                    aria-label={`Valor a usar do crédito ${cr.description}`}
                    {...MONEY_INPUT_BRL}
                    clampBehavior="none"
                    w={150}
                    min={0}
                    disabled={disabled}
                    value={value[cr.id]}
                    error={rows[cr.id] ? true : undefined}
                    onChange={(v) => onChange({ ...value, [cr.id]: v })}
                  />
                )}
              </Group>
              {checked && rows[cr.id] && (
                <Text size="xs" c="red" mt={2}>
                  {rows[cr.id]}
                </Text>
              )}
            </div>
          );
        })}
      </Stack>
      {overall && (
        <Text size="xs" c="red" mt="xs">
          {overall}
        </Text>
      )}
      {sum > 0 && (
        <Text size="sm" c="dimmed" ta="right" mt="xs">
          Total de créditos: -{brl(sum)} · A parcelar: {brl(toSplit)}
        </Text>
      )}
    </Paper>
  );
}
