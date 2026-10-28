import { useState } from 'react';
import {
  Stack,
  Title,
  Text,
  Paper,
  Group,
  Button,
  Anchor,
  FileButton,
  ActionIcon,
  Code,
  Table,
  Modal,
  TextInput,
  Alert,
} from '@mantine/core';
import { Select } from '../components/Select';
import { IconUpload, IconDownload, IconTrash, IconRefresh, IconAlertTriangle } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, TemplateInfo, TemplateKind } from '../api/client';

const KINDS: { kind: TemplateKind; label: string; hint: string }[] = [
  { kind: 'contract', label: 'Modelos de Contrato', hint: 'Usados em contratos únicos. O contrato escolhe qual modelo usar (padrão pré-selecionado).' },
  { kind: 'invoice', label: 'Modelos de Fatura', hint: 'Usados nas faturas de contratos recorrentes. Escolhidos no contrato recorrente.' },
  { kind: 'receipt', label: 'Modelos de Recibo', hint: 'Usados para gerar recibos dos pagamentos recebidos. Cada contrato escolhe qual modelo de recibo usar.' },
];

// Every placeholder available in the templates, grouped by domain and split by
// document type, so the customer can build documents without seeing the code.
// These mirror the data objects assembled in the server generate routes
// (contracts.ts / receipts.ts) — keep them in sync when tags change.
type FieldGroup = { title: string; note?: string; fields: [string, string][] };

const CUSTOMER_GROUP: FieldGroup = {
  title: 'Cliente',
  fields: [
    ['{customer_name}', 'Nome'],
    ['{customer_nickname}', 'Apelido'],
    ['{customer_document}', 'CPF / CNPJ'],
    ['{customer_email}', 'E-mail'],
    ['{customer_phone}', 'Telefone'],
    ['{customer_whatsapp}', 'WhatsApp'],
    ['{customer_address}', 'Endereço (rua/número)'],
    ['{customer_neighborhood}', 'Bairro'],
    ['{customer_city}', 'Cidade'],
    ['{customer_uf}', 'Estado (UF)'],
  ],
};

const INSTALLMENTS_GROUP: FieldGroup = {
  title: 'Parcelas',
  note: 'Quantidade em {installments_count}. Lista com o bloco {#installments} … {/installments}:',
  fields: [
    ['{installments_count}', 'Número de parcelas'],
    ['{number}', 'Número da parcela (ex.: 1) — total em {installments_count}'],
    ['{due_date}', 'Vencimento da parcela'],
    ['{amount}', 'Valor da parcela'],
  ],
};

const CREDIT_GROUP: FieldGroup = {
  title: 'Crédito do cliente',
  note: 'Só há valores quando um crédito foi usado. Use o bloco {#credit_used} … {/credit_used} para exibir algo apenas quando houver crédito.',
  fields: [
    ['{credit_used}', 'Indica se um crédito foi aplicado (bloco condicional)'],
    ['{credit_description}', 'Descrição do crédito utilizado'],
    ['{credit_applied}', 'Valor do crédito aplicado (negativo, ex.: -R$ 300,00)'],
    ['{total_after_credit}', 'Valor a pagar após o crédito (igual a {total})'],
  ],
};

const MODIFIERS_GROUP: FieldGroup = {
  title: 'Modificadores',
  note: 'Modificadores de valor livre do contrato ou da fatura. Bloco {#modifiers} … {/modifiers}:',
  fields: [
    ['{name}', 'Descrição do modificador'],
    ['{price}', 'Valor (pode ser negativo)'],
    ['{discount_percent}', 'Desconto do modificador (%)'],
    ['{line_total}', 'Valor após desconto'],
  ],
};

const FIELD_GROUPS_BY_KIND: Record<TemplateKind, FieldGroup[]> = {
  contract: [
    CUSTOMER_GROUP,
    {
      title: 'Contrato',
      fields: [
        ['{contract_number}', 'Número do contrato (ex.: 26/001)'],
        ['{contract_type}', '"Contrato" ou "Fatura"'],
        ['{title}', 'Título do contrato'],
        ['{execution_date}', 'Data de execução'],
        ['{execution_time}', 'Hora de execução'],
        ['{execution_address}', 'Endereço de execução'],
        ['{comments}', 'Comentários'],
        ['{date}', 'Data de geração por extenso (ex.: 07 de Agosto de 2026)'],
        ['{date_short}', 'Data de geração em dd/mm/aaaa (ex.: 07/08/2026)'],
        ['{date_long}', 'Data de geração por extenso (igual a {date})'],
      ],
    },
    {
      title: 'Serviço',
      note: 'Um contrato único tem um único serviço, disponível direto (sem bloco):',
      fields: [
        ['{service_name}', 'Nome do serviço (= título do contrato)'],
        ['{service_base_price}', 'Preço base do serviço'],
        ['{service_total}', 'Total do serviço (com adicionais e desconto)'],
        ['{quantity}', 'Quantidade do serviço'],
        ['{duration}', 'Duração (ex.: 2 horas, 3 meses)'],
        ['{discount_percent}', 'Desconto do serviço (%)'],
        ['{#additionals}{name} x{quantity} {unit_price} {line_total}{/additionals}', 'Adicionais do serviço (lista)'],
      ],
    },
    {
      title: 'Valores',
      note: 'Use o bloco {#has_discount} … {/has_discount} para mostrar a linha de desconto só quando houver desconto (esconde quando for 0).',
      fields: [
        ['{subtotal}', 'Valor base + modificadores, sem nenhum desconto'],
        ['{discount_total}', 'Soma de todos os descontos (itens, adicionais e modificadores)'],
        ['{has_discount}', 'Verdadeiro quando há desconto (bloco condicional)'],
        ['{total}', 'Valor final a pagar (já com o crédito descontado)'],
        ['{total_before_credit}', 'Valor final antes do crédito'],
      ],
    },
    CREDIT_GROUP,
    INSTALLMENTS_GROUP,
    {
      title: 'Itens (lista)',
      note: 'Além do serviço direto acima, os itens também estão disponíveis como lista. Use {#items} … {/items}:',
      fields: [
        ['{service_name}', 'Nome do serviço'],
        ['{description}', 'Descrição'],
        ['{quantity}', 'Quantidade'],
        ['{base_price}', 'Preço unitário'],
        ['{base_total}', 'Preço unitário × quantidade (sem adicionais)'],
        ['{line_total}', 'Total do item (com adicionais)'],
        ['{#additionals}{name} x{quantity} {unit_price} {line_total}{/additionals}', 'Adicionais do item (lista)'],
      ],
    },
    MODIFIERS_GROUP,
  ],
  invoice: [
    CUSTOMER_GROUP,
    {
      title: 'Fatura',
      fields: [
        ['{contract_number}', 'Número do contrato recorrente (ex.: F001)'],
        ['{title}', 'Título do contrato'],
        ['{invoice_reference}', 'Referência da fatura (ex.: Agosto/2026)'],
        ['{invoice_number}', 'Número sequencial da fatura (ex.: 001-26)'],
        ['{comments}', 'Comentários'],
        ['{date}', 'Data de geração por extenso (ex.: 07 de Agosto de 2026)'],
        ['{date_short}', 'Data de geração em dd/mm/aaaa (ex.: 07/08/2026)'],
        ['{date_long}', 'Data de geração por extenso (igual a {date})'],
      ],
    },
    {
      title: 'Valores',
      note: 'Use o bloco {#has_discount} … {/has_discount} para mostrar a linha de desconto só quando houver desconto (esconde quando for 0).',
      fields: [
        ['{subtotal}', 'Valor base + modificadores, sem nenhum desconto'],
        ['{discount_percent}', 'Desconto percentual da fatura'],
        ['{discount_total}', 'Soma de todos os descontos (itens, adicionais, desconto da fatura e modificadores)'],
        ['{has_discount}', 'Verdadeiro quando há desconto (bloco condicional)'],
        ['{total}', 'Valor final a pagar (já com o crédito descontado)'],
        ['{total_before_credit}', 'Valor final antes do crédito'],
      ],
    },
    CREDIT_GROUP,
    INSTALLMENTS_GROUP,
    {
      title: 'Resumo dos serviços',
      note: 'Lista resumida: o mesmo serviço agrupado em uma linha, com quantidade e valor somados (ex.: página de resumo). Serviços com adicionais diferentes aparecem em linhas separadas. Use {#items_summary} … {/items_summary}. Dentro dele:',
      fields: [
        ['{item_number}', 'Número sequencial da linha (1, 2, 3…)'],
        ['{service_name}', 'Nome do serviço'],
        ['{quantity}', 'Quantidade total desse serviço'],
        ['{base_price}', 'Preço unitário do serviço'],
        ['{total}', 'Valor somado desse serviço'],
        ['{#additionals}{name} x{quantity} {unit_price}{/additionals}', 'Adicionais da linha (lista, por unidade)'],
      ],
    },
    {
      title: 'Itens dos serviços',
      note: 'Lista detalhada: um serviço realizado por linha, com descrição. Use {#items} … {/items}. Dentro dele:',
      fields: [
        ['{item_number}', 'Número sequencial do item (1, 2, 3…)'],
        ['{service_name}', 'Nome do serviço'],
        ['{description}', 'Descrição (ex.: título do vídeo)'],
        ['{performed_at}', 'Data de realização'],
        ['{quantity}', 'Quantidade'],
        ['{base_price}', 'Preço unitário'],
        ['{base_total}', 'Preço unitário × quantidade (sem adicionais)'],
        ['{line_total}', 'Total do item (com adicionais)'],
        ['{#additionals}{name} x{quantity} {unit_price} {line_total}{/additionals}', 'Adicionais do item (lista)'],
      ],
    },
    MODIFIERS_GROUP,
  ],
  receipt: [
    CUSTOMER_GROUP,
    {
      title: 'Recibo',
      fields: [
        ['{contract_number}', 'Número do contrato ligado (se houver)'],
        ['{service_name}', 'Nome do serviço (título do contrato)'],
        ['{invoice_reference}', 'Referência da fatura (contratos recorrentes)'],
        ['{invoice_number}', 'Número sequencial da fatura (ex.: 001-26)'],
        ['{description}', 'Descrição do pagamento'],
        ['{amount}', 'Valor do pagamento'],
        ['{amount_left}', 'Saldo restante do contrato após este recebimento'],
        ['{installment}', 'Parcela (ex.: 1/3)'],
        ['{due_date}', 'Vencimento da parcela'],
        ['{date}', 'Data do recebimento (por extenso)'],
        ['{date_short}', 'Data do recebimento em dd/mm/aaaa (ex.: 07/08/2026)'],
        ['{date_long}', 'Data do recebimento por extenso (igual a {date})'],
      ],
    },
  ],
};

const FIELD_KIND_OPTIONS: { value: TemplateKind; label: string }[] = [
  { value: 'contract', label: 'Contrato' },
  { value: 'invoice', label: 'Fatura' },
  { value: 'receipt', label: 'Recibo' },
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Templates() {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery({
    queryKey: ['/templates'],
    queryFn: () => api.get<TemplateInfo[]>('/templates'),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['/templates'] });
  const err = (e: Error) => notifications.show({ message: e.message, color: 'red' });

  // Document type selected in the "Campos disponíveis" reference section.
  const [fieldsKind, setFieldsKind] = useState<TemplateKind>('contract');

  // Add-template modal (name + file).
  const [addKind, setAddKind] = useState<TemplateKind | null>(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const add = useMutation({
    mutationFn: async () => {
      const content = await fileToBase64(file!);
      return api.post('/templates', { kind: addKind, name, fileName: file!.name, content });
    },
    onSuccess: () => {
      invalidate();
      setAddKind(null);
      setName('');
      setFile(null);
      notifications.show({ message: 'Modelo adicionado', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ title: 'Falha no envio', message: e.message, color: 'red' }),
  });

  // Replace-in-place: upload a new .docx that overwrites the template's content
  // (same id), so contracts/faturas keep their link.
  const [replaceTarget, setReplaceTarget] = useState<TemplateInfo | null>(null);
  const [replaceFile, setReplaceFile] = useState<File | null>(null);

  const replaceContent = useMutation({
    mutationFn: async () => {
      const content = await fileToBase64(replaceFile!);
      return api.put(`/templates/${replaceTarget!.id}/content`, { content, fileName: replaceFile!.name });
    },
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['/contracts'] });
      setReplaceTarget(null);
      setReplaceFile(null);
      notifications.show({ message: 'Modelo substituído', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ title: 'Falha ao substituir', message: e.message, color: 'red' }),
  });

  // Delete only removes a template not in use; in-use ones are blocked server-side
  // (the user should use "Substituir" instead).
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/templates/${id}`),
    onSuccess: () => {
      invalidate();
      notifications.show({ message: 'Modelo excluído', color: 'green' });
    },
    onError: err,
  });

  return (
    <Stack>
      <div>
        <Title order={2}>Modelos de documentos</Title>
        <Text size="sm" c="dimmed">
          Envie modelos do Word (.docx) ou do LibreOffice (.odt). Um modelo .odt é usado como está: os documentos
          gerados continuam em .odt e o PDF sai direto do LibreOffice. Ficam no banco e são compartilhados por todas as máquinas. Ao
          criar um contrato ou fatura é <b>obrigatório escolher</b> um modelo desta lista, incluindo o
          modelo de recibo.
        </Text>
      </div>

      {KINDS.map(({ kind, label, hint }) => {
        const list = templates.filter((t) => t.kind === kind);
        return (
          <Paper key={kind} withBorder p="md" radius="md">
            <Group justify="space-between" mb="xs">
              <div>
                <Text fw={600}>{label}</Text>
                <Text size="xs" c="dimmed">
                  {hint}
                </Text>
              </div>
              <Button
                variant="light"
                leftSection={<IconUpload size={16} />}
                onClick={() => {
                  setAddKind(kind);
                  setName('');
                  setFile(null);
                }}
              >
                Adicionar
              </Button>
            </Group>
            {list.length === 0 ? (
              <Text size="sm" c="dimmed">
                Nenhum modelo cadastrado.
              </Text>
            ) : (
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Nome</Table.Th>
                    <Table.Th>Arquivo</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.map((t) => (
                    <Table.Tr key={t.id}>
                      <Table.Td>{t.name}</Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {t.fileName}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <Anchor href={`/api/templates/${t.id}/download`}>
                            <ActionIcon variant="subtle" title="Baixar">
                              <IconDownload size={16} />
                            </ActionIcon>
                          </Anchor>
                          <ActionIcon
                            variant="subtle"
                            title="Substituir (enviar novo arquivo)"
                            onClick={() => {
                              setReplaceTarget(t);
                              setReplaceFile(null);
                            }}
                          >
                            <IconRefresh size={16} />
                          </ActionIcon>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            title="Excluir"
                            onClick={() => {
                              if (confirm(`Excluir o modelo "${t.name}"?`)) remove.mutate(t.id);
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
            )}
          </Paper>
        );
      })}

      <Paper withBorder p="md" radius="md">
        <Title order={5}>Campos disponíveis no modelo</Title>
        <Text size="sm" c="dimmed" mb="sm">
          Escreva estes campos entre chaves dentro do documento do Word. Campos não preenchidos
          aparecem em branco. Selecione o tipo de documento para ver os campos disponíveis nele.
        </Text>
        <Select
          label="Tipo de documento"
          data={FIELD_KIND_OPTIONS}
          value={fieldsKind}
          onChange={(v) => v && setFieldsKind(v as TemplateKind)}
          allowDeselect={false}
          maw={260}
          mb="md"
        />
        <Stack gap="lg">
          {FIELD_GROUPS_BY_KIND[fieldsKind].map((g) => (
            <div key={g.title}>
              <Text fw={600}>{g.title}</Text>
              {g.note && (
                <Text size="xs" c="dimmed">
                  {g.note}
                </Text>
              )}
              <Table mt={4} withRowBorders={false} verticalSpacing={2}>
                <Table.Tbody>
                  {g.fields.map(([code, meaning]) => (
                    <Table.Tr key={code}>
                      <Table.Td w={280}>
                        <Code>{code}</Code>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {meaning}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          ))}
        </Stack>
      </Paper>

      <Modal
        opened={addKind != null}
        onClose={() => setAddKind(null)}
        title={
          addKind === 'invoice'
            ? 'Adicionar modelo de fatura'
            : addKind === 'receipt'
              ? 'Adicionar modelo de recibo'
              : 'Adicionar modelo de contrato'
        }
      >
        <Stack>
          <TextInput
            label="Nome do modelo"
            placeholder="Ex.: Contrato padrão, Contrato simplificado…"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
          />
          <Group>
            <FileButton accept=".docx,.odt" onChange={setFile}>
              {(props) => (
                <Button {...props} variant="default" leftSection={<IconUpload size={16} />}>
                  {file ? 'Trocar arquivo' : 'Escolher arquivo (.docx ou .odt)'}
                </Button>
              )}
            </FileButton>
            {file && <Text size="sm">{file.name}</Text>}
          </Group>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setAddKind(null)}>
              Cancelar
            </Button>
            <Button loading={add.isPending} disabled={!name || !file} onClick={() => add.mutate()}>
              Adicionar
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* replace-in-place modal: upload a new file that overwrites this template */}
      <Modal
        opened={replaceTarget != null}
        onClose={() => setReplaceTarget(null)}
        title={`Substituir modelo — ${replaceTarget?.name ?? ''}`}
      >
        <Stack>
          <Alert color="blue" variant="light" icon={<IconAlertTriangle size={16} />}>
            Envie um novo arquivo <b>.docx</b> ou <b>.odt</b>. Ele substitui o conteúdo deste modelo, mantendo o vínculo
            com os contratos/faturas que já o utilizam.
          </Alert>
          <Group>
            <FileButton accept=".docx,.odt" onChange={setReplaceFile}>
              {(props) => (
                <Button {...props} variant="default" leftSection={<IconUpload size={16} />}>
                  {replaceFile ? 'Trocar arquivo' : 'Escolher arquivo (.docx ou .odt)'}
                </Button>
              )}
            </FileButton>
            {replaceFile && <Text size="sm">{replaceFile.name}</Text>}
          </Group>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setReplaceTarget(null)}>
              Cancelar
            </Button>
            <Button loading={replaceContent.isPending} disabled={!replaceFile} onClick={() => replaceContent.mutate()}>
              Substituir
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
