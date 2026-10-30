import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Stack,
  Group,
  Title,
  Text,
  Paper,
  Table,
  Button,
  ActionIcon,
  Modal,
  TextInput,
  NumberInput,
  Switch,
} from '@mantine/core';
import { IconArrowLeft, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, Customer, CustomerCredit, CustomerCharge } from '../api/client';
import { formatBr } from '../lib/dates';
import { MONEY_INPUT_BRL } from '../lib/money';

const brl = (n: any) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function CustomerDetail() {
  const { id } = useParams();
  const customerId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: customer } = useQuery({
    queryKey: ['/customers', customerId],
    queryFn: () => api.get<Customer>(`/customers/${customerId}`),
  });
  const { data: credits = [] } = useQuery({
    queryKey: ['/customers', customerId, 'credits'],
    queryFn: () => api.get<CustomerCredit[]>(`/customers/${customerId}/credits?all=1`),
  });
  const { data: charges = [] } = useQuery({
    queryKey: ['/customers', customerId, 'charges'],
    queryFn: () => api.get<CustomerCharge[]>(`/customers/${customerId}/charges`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['/customers', customerId, 'credits'] });

  const [showUsed, setShowUsed] = useState(false);
  const active = credits.filter((c) => Number(c.remaining) > 0);
  const used = credits.filter((c) => Number(c.remaining) <= 0);

  const [addOpen, setAddOpen] = useState(false);
  const [desc, setDesc] = useState('');
  const [value, setValue] = useState<number | string>(0);
  const addCredit = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/credits`, { description: desc, value: Number(value) }),
    onSuccess: () => {
      invalidate();
      setAddOpen(false);
      setDesc('');
      setValue(0);
      notifications.show({ message: 'Crédito adicionado', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });
  const delCredit = useMutation({
    mutationFn: (cid: number) => api.del(`/customers/${customerId}/credits/${cid}`),
    onSuccess: invalidate,
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const chargesTotal = charges.reduce((s, c) => s + Number(c.amount), 0);

  return (
    <Stack>
      <Group>
        <ActionIcon variant="subtle" onClick={() => navigate('/customers')} title="Voltar">
          <IconArrowLeft size={18} />
        </ActionIcon>
        <div>
          <Title order={2}>{customer?.name ?? 'Cliente'}</Title>
          <Text c="dimmed" size="sm">
            {[customer?.nickname, customer?.document, customer?.email, customer?.phone].filter(Boolean).join(' · ')}
          </Text>
        </div>
      </Group>

      {/* Credits */}
      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Title order={4}>Créditos</Title>
          <Group>
            <Switch label="Mostrar utilizados" checked={showUsed} onChange={(e) => setShowUsed(e.currentTarget.checked)} />
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => { setDesc(''); setValue(0); setAddOpen(true); }}>
              Novo crédito
            </Button>
          </Group>
        </Group>

        {active.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nenhum crédito disponível.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Descrição</Table.Th>
                  <Table.Th ta="right">Valor original</Table.Th>
                  <Table.Th ta="right">Restante</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {active.map((c) => (
                  <Table.Tr key={c.id}>
                    <Table.Td>{c.description}</Table.Td>
                    <Table.Td ta="right">{brl(c.value)}</Table.Td>
                    <Table.Td ta="right">
                      <b>{brl(c.remaining)}</b>
                    </Table.Td>
                    <Table.Td ta="right">
                      {Number(c.remaining) === Number(c.value) && (
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          title="Excluir crédito"
                          onClick={() => {
                            if (confirm('Excluir este crédito?')) delCredit.mutate(c.id);
                          }}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}

        {showUsed && (
          <>
            <Text size="xs" c="dimmed" mt="md" mb={4}>
              Utilizados
            </Text>
            {used.length === 0 ? (
              <Text size="sm" c="dimmed">
                Nenhum crédito utilizado.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={640}>
                <Table striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Descrição</Table.Th>
                      <Table.Th ta="right">Valor original</Table.Th>
                      <Table.Th ta="right">Restante</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {used.map((c) => (
                      <Table.Tr key={c.id}>
                        <Table.Td>
                          <Text size="sm" c="dimmed">
                            {c.description}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">{brl(c.value)}</Table.Td>
                        <Table.Td ta="right">{brl(c.remaining)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </>
        )}
      </Paper>

      {/* Pending charges */}
      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Title order={4}>Cobranças pendentes</Title>
          {charges.length > 0 && <Text fw={600}>{brl(chargesTotal)}</Text>}
        </Group>
        {charges.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nenhuma cobrança pendente.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Vencimento</Table.Th>
                  <Table.Th>Descrição</Table.Th>
                  <Table.Th>Contrato</Table.Th>
                  <Table.Th ta="right">Valor</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {charges.map((c) => (
                  <Table.Tr key={c.id}>
                    <Table.Td>{formatBr(c.dueDate)}</Table.Td>
                    <Table.Td>{c.description}</Table.Td>
                    <Table.Td>{c.contractNumber ?? '—'}</Table.Td>
                    <Table.Td ta="right">{brl(c.amount)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>

      {/* Add credit modal */}
      <Modal opened={addOpen} onClose={() => setAddOpen(false)} title="Novo crédito">
        <Stack>
          <TextInput
            label="Descrição"
            placeholder="Ex.: Pagamento adiantado"
            value={desc}
            onChange={(e) => setDesc(e.currentTarget.value)}
            required
          />
          <NumberInput label="Valor" {...MONEY_INPUT_BRL} min={0} value={value} onChange={setValue} required />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setAddOpen(false)}>
              Cancelar
            </Button>
            <Button loading={addCredit.isPending} disabled={!desc || !(Number(value) > 0)} onClick={() => addCredit.mutate()}>
              Adicionar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
