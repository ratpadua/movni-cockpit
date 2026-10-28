import { useEffect, useState } from 'react';
import { Modal, Stack, Radio, Text, Group, Button } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { api, Payment } from '../api/client';
import { isPaymentOpen } from '../lib/paymentStatus';

export type SeriesScope = 'one' | 'following' | 'all';

// Asks which payments of a recurring series an edit or a delete applies to. Only open
// payments of the series are ever affected (paid/received ones are kept), and the
// counts shown mirror the server's rule (routes/payments.ts, seriesTargets).
export default function RecurrenceScopeModal({
  opened,
  payment,
  mode,
  loading,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  payment: Payment | null;
  mode: 'save' | 'delete';
  loading?: boolean;
  onClose: () => void;
  onConfirm: (scope: SeriesScope) => void;
}) {
  const { data: payments = [] } = useQuery({
    queryKey: ['/payments'],
    queryFn: () => api.get<Payment[]>('/payments'),
    enabled: opened,
  });
  const [scope, setScope] = useState<SeriesScope>('one');
  useEffect(() => {
    if (opened) setScope('one');
  }, [opened]);

  const others = payment?.recurrenceId
    ? payments.filter((p) => p.recurrenceId === payment.recurrenceId && p.id !== payment.id && isPaymentOpen(p))
    : [];
  const following = others.filter((p) => (p.dueDate ?? '') >= (payment?.dueDate ?? '')).length;
  const plural = (n: number) => (n === 1 ? '1 outro' : `${n} outros`);
  const isDelete = mode === 'delete';

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={isDelete ? 'Excluir pagamento recorrente' : 'Salvar pagamento recorrente'}
    >
      <Stack>
        <Text size="sm">
          Este pagamento faz parte de uma série recorrente. A quais pagamentos aplicar?
        </Text>
        <Radio.Group value={scope} onChange={(v) => setScope(v as SeriesScope)}>
          <Stack gap="xs">
            <Radio value="one" label="Só este pagamento" />
            <Radio value="following" label={`Este e os próximos em aberto (+${plural(following)})`} />
            <Radio value="all" label={`Todos os pagamentos em aberto da série (+${plural(others.length)})`} />
          </Stack>
        </Radio.Group>
        <Text size="xs" c="dimmed">
          {isDelete
            ? 'Pagamentos já pagos ou recebidos da série são mantidos.'
            : 'Descrição, valor, categoria, cliente e contrato são aplicados aos escolhidos. Cada pagamento mantém seu vencimento e sua situação, e os já pagos ou recebidos não mudam.'}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button color={isDelete ? 'red' : undefined} loading={loading} onClick={() => onConfirm(scope)}>
            {isDelete ? 'Excluir' : 'Salvar'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
