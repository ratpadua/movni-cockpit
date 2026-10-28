import { useState } from 'react';
import {
  Button,
  Group,
  Modal,
  Table,
  TextInput,
  NumberInput,
  Textarea,
  Title,
  ActionIcon,
  Text,
  Stack,
  Paper,
} from '@mantine/core';
import { Select } from './Select';
import {
  IconPlus,
  IconEdit,
  IconTrash,
  IconSearch,
  IconSortAscendingLetters,
  IconSortDescendingLetters,
} from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api } from '../api/client';
import DateField from './DateField';
import { formatBr } from '../lib/dates';

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'select' | 'date' | 'textarea';
  options?: { value: string; label: string }[];
  required?: boolean;
  inTable?: boolean; // show as a table column (default true)
  placeholder?: string;
  format?: (row: any) => React.ReactNode; // custom cell render
}

// Client-side filters rendered above the table (combine with AND).
export interface FilterDef {
  key: string; // unique control key
  label: string;
  kind: 'select' | 'dateFrom' | 'dateTo';
  field?: string; // row field to compare (defaults to key)
  options?: { value: string; label: string }[];
}

interface Props {
  title: string;
  path: string; // e.g. "/customers"
  fields: FieldDef[];
  filters?: FilterDef[];
  // Display-only columns (not part of the add/edit form).
  extraColumns?: { label: string; render: (row: any) => React.ReactNode }[];
  searchable?: boolean; // show a text search box (default true)
  sortable?: boolean; // show sort-by + A→Z/Z→A controls (default true)
  searchFields?: string[]; // row keys to search (default: table columns)
  onRowClick?: (row: any) => void; // makes rows clickable (e.g. open a detail page)
}

// Accent- and case-insensitive normalization for search/sort.
function norm(v: any): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matchesFilters(row: any, filters: FilterDef[], values: Record<string, string>): boolean {
  for (const f of filters) {
    const v = values[f.key];
    if (!v) continue;
    const field = f.field ?? f.key;
    const cell = row[field];
    if (f.kind === 'select') {
      if (String(cell ?? '') !== v) return false;
    } else if (f.kind === 'dateFrom') {
      if (!cell || String(cell) < v) return false;
    } else if (f.kind === 'dateTo') {
      if (!cell || String(cell) > v) return false;
    }
  }
  return true;
}

export default function ResourceManager({
  title,
  path,
  fields,
  filters,
  extraColumns = [],
  searchable = true,
  sortable = true,
  searchFields,
  onRowClick,
}: Props) {
  const qc = useQueryClient();
  const key = [path];
  const { data: rawData = [], isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<any[]>(path) });

  const tableFields = fields.filter((f) => f.inTable !== false);
  const searchKeys = searchFields ?? tableFields.map((f) => f.key);

  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(tableFields[0]?.key ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  let data = rawData;
  if (filters && filters.length > 0) data = data.filter((row) => matchesFilters(row, filters, filterValues));
  if (search.trim()) {
    const q = norm(search);
    data = data.filter((row) => searchKeys.some((k) => norm(row[k]).includes(q)));
  }
  if (sortKey) {
    const k = sortKey;
    data = [...data].sort((a, b) => {
      const r = String(a[k] ?? '').localeCompare(String(b[k] ?? ''), 'pt-BR', {
        numeric: true,
        sensitivity: 'base',
      });
      return sortDir === 'asc' ? r : -r;
    });
  }

  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});

  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const save = useMutation({
    mutationFn: (payload: any) =>
      editing ? api.put(`${path}/${editing.id}`, payload) : api.post(path, payload),
    onSuccess: () => {
      invalidate();
      setOpened(false);
      notifications.show({ message: 'Salvo com sucesso', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`${path}/${id}`),
    onSuccess: invalidate,
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const openNew = () => {
    setEditing(null);
    setForm({});
    setOpened(true);
  };
  const openEdit = (row: any) => {
    setEditing(row);
    setForm({ ...row });
    setOpened(true);
  };

  const setField = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const hasToolbar = searchable || sortable || (filters && filters.length > 0);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{title}</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={openNew}>
          Novo
        </Button>
      </Group>

      {hasToolbar && (
        <Paper withBorder radius="md" p="sm">
          <Group align="flex-end" wrap="wrap">
            {searchable && (
              <TextInput
                label="Buscar"
                placeholder="Buscar…"
                leftSection={<IconSearch size={16} />}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                w={220}
              />
            )}
            {sortable && tableFields.length > 0 && (
              <Group align="flex-end" gap={4}>
                <Select
                  label="Ordenar por"
                  data={tableFields.map((f) => ({ value: f.key, label: f.label }))}
                  value={sortKey}
                  onChange={setSortKey}
                  w={170}
                  clearable
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
            )}
            {filters?.map((f) =>
              f.kind === 'select' ? (
                <Select
                  key={f.key}
                  label={f.label}
                  placeholder="Todos"
                  data={f.options ?? []}
                  value={filterValues[f.key] ?? null}
                  onChange={(v) => setFilterValues((s) => ({ ...s, [f.key]: v ?? '' }))}
                  clearable
                  searchable
                  w={190}
                />
              ) : (
                <DateField
                  key={f.key}
                  label={f.label}
                  value={filterValues[f.key] ?? ''}
                  onChange={(v) => setFilterValues((s) => ({ ...s, [f.key]: v }))}
                  w={170}
                  clearable
                />
              )
            )}
            {(search || Object.values(filterValues).some((v) => v)) && (
              <Button
                variant="subtle"
                color="gray"
                onClick={() => {
                  setFilterValues({});
                  setSearch('');
                }}
              >
                Limpar
              </Button>
            )}
            <Text size="sm" c="dimmed">
              {data.length} de {rawData.length}
            </Text>
          </Group>
        </Paper>
      )}

      <Paper withBorder radius="md">
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              {tableFields.map((f) => (
                <Table.Th key={f.key}>{f.label}</Table.Th>
              ))}
              {extraColumns.map((c) => (
                <Table.Th key={c.label}>{c.label}</Table.Th>
              ))}
              <Table.Th style={{ width: 90 }} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {isLoading && (
              <Table.Tr>
                <Table.Td colSpan={tableFields.length + extraColumns.length + 1}>Carregando…</Table.Td>
              </Table.Tr>
            )}
            {!isLoading && data.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={tableFields.length + extraColumns.length + 1}>
                  <Text c="dimmed">Nenhum registro.</Text>
                </Table.Td>
              </Table.Tr>
            )}
            {data.map((row) => (
              <Table.Tr
                key={row.id}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {tableFields.map((f) => (
                  <Table.Td key={f.key}>
                    {f.format ? f.format(row) : formatCell(f, row[f.key])}
                  </Table.Td>
                ))}
                {extraColumns.map((c) => (
                  <Table.Td key={c.label}>{c.render(row)}</Table.Td>
                ))}
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  <Group gap={4} justify="flex-end">
                    <ActionIcon variant="subtle" onClick={() => openEdit(row)}>
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => {
                        if (confirm('Excluir este registro?')) remove.mutate(row.id);
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

      <Modal opened={opened} onClose={() => setOpened(false)} title={editing ? 'Editar' : 'Novo'}>
        <Stack>
          {fields.map((f) => (
            <FieldInput key={f.key} field={f} value={form[f.key]} onChange={(v) => setField(f.key, v)} />
          ))}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpened(false)}>
              Cancelar
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate(normalize(fields, form))}>
              Salvar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function formatCell(f: FieldDef, value: any) {
  if (value == null || value === '') return '—';
  if (f.type === 'select' && f.options) {
    return f.options.find((o) => String(o.value) === String(value))?.label ?? value;
  }
  if (f.type === 'date') return formatBr(String(value));
  return String(value);
}

// Coerce number fields and drop empty strings so the API gets clean values.
function normalize(fields: FieldDef[], form: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const f of fields) {
    let v = form[f.key];
    if (v === '' || v === undefined) v = null;
    out[f.key] = v;
  }
  return out;
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: any;
  onChange: (v: any) => void;
}) {
  const common = {
    label: field.label,
    required: field.required,
    placeholder: field.placeholder,
    value: value ?? '',
  };
  switch (field.type) {
    case 'number':
      return (
        <NumberInput
          label={field.label}
          required={field.required}
          value={value ?? ''}
          onChange={(v) => onChange(v)}
          decimalScale={2}
        />
      );
    case 'select':
      return (
        <Select
          label={field.label}
          required={field.required}
          data={field.options ?? []}
          value={value != null ? String(value) : null}
          onChange={(v) => onChange(v)}
          searchable
          clearable
        />
      );
    case 'date':
      return <DateField {...common} onChange={onChange} />;
    case 'textarea':
      return <Textarea {...common} onChange={(e) => onChange(e.currentTarget.value)} autosize minRows={2} />;
    default:
      return <TextInput {...common} onChange={(e) => onChange(e.currentTarget.value)} />;
  }
}
