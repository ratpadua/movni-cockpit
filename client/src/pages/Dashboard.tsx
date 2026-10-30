import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { SimpleGrid, Paper, Text, Title, Stack, Table, Badge, Group, ScrollArea } from '@mantine/core';
import { api, Payment, Customer, OverdueContract } from '../api/client';
import { STATUS_LABELS } from '../lib/status';
import { isPaymentLate, isPaymentOpen, paymentSituation } from '../lib/paymentStatus';
import { formatBr } from '../lib/dates';

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="xl" fw={700} c={color}>
        {value}
      </Text>
    </Paper>
  );
}

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function Dashboard() {
  const navigate = useNavigate();
  const { data: payments = [] } = useQuery({
    queryKey: ['/payments'],
    queryFn: () => api.get<Payment[]>('/payments'),
  });
  const { data: customers = [] } = useQuery({
    queryKey: ['/customers'],
    queryFn: () => api.get<Customer[]>('/customers'),
  });
  const { data: overdue = [] } = useQuery({
    queryKey: ['/contracts/overdue'],
    queryFn: () => api.get<OverdueContract[]>('/contracts/overdue'),
  });

  // Open = still unsettled: Aberto / A pagar, and Atrasado (which is open + past due).
  // Earliest due date first; payments without a due date last.
  const open = payments
    .filter((p) => isPaymentOpen(p))
    .sort((a, b) => {
      if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      }
      return a.id - b.id;
    });
  // A receber = entradas Aberto or Atrasado (received ones are excluded).
  const toReceive = open.filter((p) => p.flow === 'in').reduce((s, p) => s + Number(p.amount), 0);
  const toPay = open.filter((p) => p.flow === 'out').reduce((s, p) => s + Number(p.amount), 0);

  // Late = past due and not settled (entrada not received / saída not paid).
  const latePayments = payments
    .filter((p) => isPaymentLate(p))
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));

  return (
    <Stack>
      <Title order={2}>Painel</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }}>
        <Stat label="A receber" value={brl(toReceive)} color="green" />
        <Stat label="A pagar" value={brl(toPay)} color="red" />
        <Stat label="Clientes" value={String(customers.length)} />
        <Stat label="Pagamentos atrasados" value={String(latePayments.length)} color={latePayments.length ? 'red' : undefined} />
        <Stat label="Contratos atrasados" value={String(overdue.length)} color={overdue.length ? 'red' : undefined} />
      </SimpleGrid>

      {latePayments.length > 0 && (
        <Paper withBorder radius="md" p="md">
          <Title order={4} mb="sm" c="red">
            Pagamentos atrasados
          </Title>
          <Table.ScrollContainer minWidth={640}>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Vencimento</Table.Th>
                  <Table.Th>Descrição</Table.Th>
                  <Table.Th>Cliente</Table.Th>
                  <Table.Th>Tipo</Table.Th>
                  <Table.Th ta="right">Valor</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {latePayments.map((p) => (
                  <Table.Tr
                    key={p.id}
                    style={{ cursor: p.contractId ? 'pointer' : 'default' }}
                    onClick={() => p.contractId && navigate(`/contracts/${p.contractId}`)}
                  >
                    <Table.Td c="red">{formatBr(p.dueDate)}</Table.Td>
                    <Table.Td>
                      {p.description}
                      {p.contractNumber ? ` · ${p.contractNumber}` : ''}
                    </Table.Td>
                    <Table.Td>{p.customerNickname || p.customerName || '—'}</Table.Td>
                    <Table.Td>
                      <Badge color={p.flow === 'in' ? 'green' : 'red'} variant="light">
                        {p.flow === 'in' ? 'Entrada' : 'Saída'}
                      </Badge>
                    </Table.Td>
                    <Table.Td ta="right">{brl(Number(p.amount))}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}

      {overdue.length > 0 && (
        <Paper withBorder radius="md" p="md">
          <Title order={4} mb="sm" c="red">
            Contratos atrasados
          </Title>
          <Table.ScrollContainer minWidth={640}>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Contrato</Table.Th>
                  <Table.Th>Cliente</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Prazo</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {overdue.map((o) => (
                  <Table.Tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${o.id}`)}>
                    <Table.Td fw={600}>
                      {o.number ?? `#${o.id}`}
                      {o.title ? ` — ${o.title}` : ''}
                    </Table.Td>
                    <Table.Td>{o.customerName ?? '—'}</Table.Td>
                    <Table.Td>
                      <Badge color="red" variant="light">
                        {STATUS_LABELS[o.status]}
                      </Badge>
                    </Table.Td>
                    <Table.Td c="red">{new Date(o.deadline).toLocaleDateString('pt-BR')}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}

      <Paper withBorder radius="md" p="md">
        <Title order={4} mb="sm">
          Próximos pagamentos
        </Title>
        <ScrollArea.Autosize mah={360} type="auto" offsetScrollbars>
          <Table striped stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Descrição</Table.Th>
                <Table.Th>Tipo</Table.Th>
                <Table.Th>Situação</Table.Th>
                <Table.Th>Vencimento</Table.Th>
                <Table.Th ta="right">Valor</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {open.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text c="dimmed">Nenhum pagamento pendente.</Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {open.map((p) => {
                const s = paymentSituation(p);
                return (
                  <Table.Tr key={p.id}>
                    <Table.Td>{p.description}</Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <Badge color={p.flow === 'in' ? 'green' : 'red'} variant="light">
                          {p.flow === 'in' ? 'Entrada' : 'Saída'}
                        </Badge>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={s.color} variant="light">
                        {s.label}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{formatBr(p.dueDate)}</Table.Td>
                    <Table.Td ta="right">{brl(Number(p.amount))}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Paper>
    </Stack>
  );
}
