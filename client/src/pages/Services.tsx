import { useState, useMemo } from 'react';
import {
  Stack,
  Title,
  Group,
  Button,
  Paper,
  Table,
  Text,
  Modal,
  TextInput,
  NumberInput,
  Textarea,
  ActionIcon,
  Badge,
  Alert,
  Divider,
} from '@mantine/core';
import { Select } from '../components/Select';
import {
  IconPlus,
  IconEdit,
  IconTrash,
  IconVersions,
  IconHistory,
  IconInfoCircle,
  IconSearch,
  IconSortAscendingLetters,
  IconSortDescendingLetters,
} from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, ServiceCatalog, ServiceDetail } from '../api/client';
import { MONEY_INPUT_BRL } from '../lib/money';
import AdditionalEditor, { AdditionalDraft } from '../components/ModifierEditor';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const norm = (v: any) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

type SortKey = 'name' | 'version' | 'basePrice';
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name', label: 'Serviço' },
  { value: 'version', label: 'Versão' },
  { value: 'basePrice', label: 'Preço base' },
];

export default function Services() {
  const qc = useQueryClient();
  const { data: services = [], isLoading } = useQuery({
    queryKey: ['/services'],
    queryFn: () => api.get<ServiceCatalog[]>('/services'),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['/services'] });

  // ---- search + ordering ----
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const visible = useMemo(() => {
    let list = services;
    if (search.trim()) {
      const q = norm(search);
      list = list.filter((s) =>
        [s.name, s.description, ...(s.currentVersion?.additionals ?? []).map((a) => a.name)].some((x) =>
          norm(x).includes(q)
        )
      );
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      let r: number;
      if (sortKey === 'version') r = Number(a.currentVersion?.version ?? 0) - Number(b.currentVersion?.version ?? 0);
      else if (sortKey === 'basePrice')
        r = Number(a.currentVersion?.basePrice ?? 0) - Number(b.currentVersion?.basePrice ?? 0);
      else
        r = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'pt-BR', {
          numeric: true,
          sensitivity: 'base',
        });
      return r * dir;
    });
  }, [services, search, sortKey, sortDir]);

  // ---- create / new-version modal ----
  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<'create' | 'version'>('create');
  const [target, setTarget] = useState<ServiceCatalog | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [basePrice, setBasePrice] = useState<number | string>(0);
  const [notes, setNotes] = useState('');
  const [additionals, setAdditionals] = useState<AdditionalDraft[]>([]);

  // ---- versions history modal ----
  const [historyId, setHistoryId] = useState<number | null>(null);
  const { data: detail } = useQuery({
    queryKey: ['/services', historyId],
    queryFn: () => api.get<ServiceDetail>(`/services/${historyId}`),
    enabled: historyId != null,
  });

  const openCreate = () => {
    setMode('create');
    setTarget(null);
    setName('');
    setDescription('');
    setBasePrice(0);
    setNotes('');
    setAdditionals([]);
    setFormOpen(true);
  };

  const openNewVersion = (s: ServiceCatalog) => {
    setMode('version');
    setTarget(s);
    setBasePrice(Number(s.currentVersion?.basePrice ?? 0));
    setNotes('');
    setAdditionals((s.currentVersion?.additionals ?? []).map((a) => ({ name: a.name, price: Number(a.price) })));
    setFormOpen(true);
  };

  const save = useMutation({
    mutationFn: () => {
      const payload = { basePrice: Number(basePrice), notes, additionals };
      if (mode === 'create') return api.post('/services', { name, description, ...payload });
      return api.post(`/services/${target!.id}/version`, payload);
    },
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      notifications.show({ message: mode === 'create' ? 'Serviço criado' : 'Nova versão criada', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/services/${id}`),
    onSuccess: invalidate,
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  // ---- manage additionals on the current version (inside the edit modal) ----
  const [newAddName, setNewAddName] = useState('');
  const [newAddPrice, setNewAddPrice] = useState<number | string>(0);

  const addAdditional = useMutation({
    mutationFn: (v: { serviceId: number; name: string; price: number }) =>
      api.post(`/services/${v.serviceId}/additionals`, { name: v.name, price: v.price }),
    onSuccess: () => {
      invalidate();
      setNewAddName('');
      setNewAddPrice(0);
      notifications.show({ message: 'Adicional incluído', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });
  const removeAdditional = useMutation({
    mutationFn: (v: { serviceId: number; addId: number }) =>
      api.del(`/services/${v.serviceId}/additionals/${v.addId}`),
    onSuccess: invalidate,
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  // edit service (identity + additionals of the current version)
  const [renameTarget, setRenameTarget] = useState<ServiceCatalog | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameDesc, setRenameDesc] = useState('');
  const editService = services.find((s) => s.id === renameTarget?.id) ?? null;
  const rename = useMutation({
    mutationFn: () => api.put(`/services/${renameTarget!.id}`, { name: renameName, description: renameDesc }),
    onSuccess: () => {
      invalidate();
      setRenameTarget(null);
      notifications.show({ message: 'Serviço atualizado', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={2}>Serviços</Title>
          <Text size="sm" c="dimmed">
            Catálogo de serviços/produtos. São adicionados a um cliente através de um contrato.
          </Text>
        </div>
        <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>
          Novo serviço
        </Button>
      </Group>

      <Paper withBorder radius="md" p="sm">
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="Buscar"
            placeholder="Nome, descrição, adicional…"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={240}
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
            {visible.length} de {services.length}
          </Text>
        </Group>
      </Paper>

      <Paper withBorder radius="md">
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Serviço</Table.Th>
              <Table.Th>Versão atual</Table.Th>
              <Table.Th ta="right">Preço base</Table.Th>
              <Table.Th>Adicionais</Table.Th>
              <Table.Th style={{ width: 160 }} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {isLoading && (
              <Table.Tr>
                <Table.Td colSpan={5}>Carregando…</Table.Td>
              </Table.Tr>
            )}
            {!isLoading && visible.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text c="dimmed">
                    {services.length === 0 ? 'Nenhum serviço cadastrado.' : 'Nenhum serviço encontrado.'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {visible.map((s) => (
              <Table.Tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => setHistoryId(s.id)}>
                <Table.Td>
                  <Text fw={500}>{s.name}</Text>
                  {s.description && (
                    <Text size="xs" c="dimmed">
                      {s.description}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge variant="light">v{s.currentVersion?.version ?? '—'}</Badge>
                </Table.Td>
                <Table.Td ta="right">{brl(Number(s.currentVersion?.basePrice ?? 0))}</Table.Td>
                <Table.Td>
                  {(s.currentVersion?.additionals ?? []).length === 0 ? (
                    <Text size="xs" c="dimmed">
                      —
                    </Text>
                  ) : (
                    <Group gap={4}>
                      {s.currentVersion!.additionals.map((a) => (
                        <Badge key={a.id} variant="dot" color="grape">
                          {a.name} · {brl(Number(a.price))}
                        </Badge>
                      ))}
                    </Group>
                  )}
                </Table.Td>
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  <Group gap={2} justify="flex-end" wrap="nowrap">
                    <ActionIcon variant="subtle" title="Nova versão (novo preço)" onClick={() => openNewVersion(s)}>
                      <IconVersions size={16} />
                    </ActionIcon>
                    <ActionIcon variant="subtle" title="Ver detalhes" onClick={() => setHistoryId(s.id)}>
                      <IconHistory size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      title="Editar"
                      onClick={() => {
                        setRenameTarget(s);
                        setRenameName(s.name);
                        setRenameDesc(s.description ?? '');
                        setNewAddName('');
                        setNewAddPrice(0);
                      }}
                    >
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      title="Excluir"
                      onClick={() => {
                        if (confirm('Excluir este serviço e todas as versões?')) remove.mutate(s.id);
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

      {/* create / new-version modal */}
      <Modal
        opened={formOpen}
        onClose={() => setFormOpen(false)}
        title={mode === 'create' ? 'Novo serviço' : `Nova versão — ${target?.name}`}
        size="lg"
      >
        <Stack>
          {mode === 'create' && (
            <>
              <TextInput label="Nome" required value={name} onChange={(e) => setName(e.currentTarget.value)} />
              <Textarea label="Descrição" value={description} onChange={(e) => setDescription(e.currentTarget.value)} autosize minRows={2} />
            </>
          )}
          {mode === 'version' && (
            <Alert icon={<IconInfoCircle size={16} />} color="yellow" variant="light">
              Isto cria uma <b>nova versão</b>. Contratos já existentes continuam com o preço da versão anterior.
            </Alert>
          )}
          <NumberInput label="Preço base" {...MONEY_INPUT_BRL} value={basePrice} onChange={setBasePrice} />
          <AdditionalEditor value={additionals} onChange={setAdditionals} />
          <Textarea label="Observações" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} autosize minRows={1} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setFormOpen(false)}>
              Cancelar
            </Button>
            <Button loading={save.isPending} disabled={mode === 'create' && !name} onClick={() => save.mutate()}>
              Salvar
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* edit service: identity + additionals of the current version */}
      <Modal opened={renameTarget != null} onClose={() => setRenameTarget(null)} title="Editar serviço" size="lg">
        <Stack>
          <TextInput label="Nome" value={renameName} onChange={(e) => setRenameName(e.currentTarget.value)} />
          <Textarea label="Descrição" value={renameDesc} onChange={(e) => setRenameDesc(e.currentTarget.value)} autosize minRows={2} />

          <Divider label="Adicionais" labelPosition="left" mt="xs" />
          <Text size="xs" c="dimmed">
            Inclua ou remova adicionais na versão atual (v{editService?.currentVersion?.version ?? '—'}) sem
            criar uma nova versão. O preço base é alterado apenas criando uma nova versão.
          </Text>

          {(editService?.currentVersion?.additionals ?? []).length === 0 ? (
            <Text size="sm" c="dimmed">
              Nenhum adicional cadastrado.
            </Text>
          ) : (
            <Stack gap={6}>
              {editService!.currentVersion!.additionals.map((a) => (
                <Group key={a.id} justify="space-between">
                  <Text size="sm">
                    {a.name} · {brl(Number(a.price))}
                  </Text>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    title="Remover adicional"
                    onClick={() => removeAdditional.mutate({ serviceId: editService!.id, addId: a.id })}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              ))}
            </Stack>
          )}

          <Group align="flex-end">
            <TextInput
              label="Novo adicional"
              placeholder="Ex.: Hora extra"
              value={newAddName}
              onChange={(e) => setNewAddName(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <NumberInput label="Preço" {...MONEY_INPUT_BRL} value={newAddPrice} onChange={setNewAddPrice} w={140} />
            <Button
              leftSection={<IconPlus size={16} />}
              disabled={!newAddName.trim()}
              loading={addAdditional.isPending}
              onClick={() =>
                editService &&
                addAdditional.mutate({ serviceId: editService.id, name: newAddName.trim(), price: Number(newAddPrice) })
              }
            >
              Adicionar
            </Button>
          </Group>

          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => setRenameTarget(null)}>
              Cancelar
            </Button>
            <Button loading={rename.isPending} onClick={() => rename.mutate()}>
              Salvar
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* service detail modal */}
      <Modal
        opened={historyId != null}
        onClose={() => setHistoryId(null)}
        title={`Detalhes — ${detail?.name ?? ''}`}
        size="lg"
      >
        {!detail ? (
          <Text c="dimmed">Carregando…</Text>
        ) : (
          <Stack>
            {detail.description && <Text>{detail.description}</Text>}

            {(() => {
              const cur = detail.versions.find((v) => v.active) ?? detail.versions[0];
              if (!cur) return null;
              return (
                <Paper withBorder p="md" radius="md">
                  <Group justify="space-between">
                    <Badge color="green">Versão atual · v{cur.version}</Badge>
                    <Text fw={600}>{brl(Number(cur.basePrice))}</Text>
                  </Group>

                  <Text size="sm" fw={500} mt="sm">
                    Adicionais
                  </Text>
                  {cur.additionals.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      Nenhum
                    </Text>
                  ) : (
                    <Group gap={4} mt={4}>
                      {cur.additionals.map((a) => (
                        <Badge key={a.id} variant="dot" color="grape">
                          {a.name} · {brl(Number(a.price))}
                        </Badge>
                      ))}
                    </Group>
                  )}

                  <Text size="sm" fw={500} mt="sm">
                    Observações
                  </Text>
                  <Text size="sm" c={cur.notes ? undefined : 'dimmed'} style={{ whiteSpace: 'pre-wrap' }}>
                    {cur.notes || 'Nenhuma'}
                  </Text>
                </Paper>
              );
            })()}

            <Divider label="Histórico de versões" labelPosition="left" />

            {detail.versions.map((v) => (
              <Paper key={v.id} withBorder p="sm" radius="md">
                <Group justify="space-between">
                  <Group gap="xs">
                    <Badge variant={v.active ? 'filled' : 'light'} color={v.active ? 'green' : 'gray'}>
                      v{v.version} {v.active ? '(atual)' : ''}
                    </Badge>
                    <Text fw={500}>{brl(Number(v.basePrice))}</Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {new Date(v.createdAt).toLocaleString('pt-BR')}
                  </Text>
                </Group>
                {v.additionals.length > 0 && (
                  <Group gap={4} mt={6}>
                    {v.additionals.map((a) => (
                      <Badge key={a.id} variant="dot" color="grape">
                        {a.name} · {brl(Number(a.price))}
                      </Badge>
                    ))}
                  </Group>
                )}
                {v.notes && (
                  <Text size="sm" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
                    <b>Observações:</b> {v.notes}
                  </Text>
                )}
              </Paper>
            ))}
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
