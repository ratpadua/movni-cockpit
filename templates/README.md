# Modelos de documentos

Os modelos de **contrato**, **fatura** e **recibo** são enviados **pelo aplicativo**, na tela
**Modelos**, e ficam salvos no banco de dados (compartilhados entre todas as máquinas). Esta pasta
contém apenas documentação — não é necessário colocar arquivos aqui.

> A tela **Modelos** tem uma versão interativa desta lista (escolha o tipo de documento e veja só os
> campos dele). Em caso de dúvida, ela é a referência mais atual.

## Formatos aceitos

- **Word** (`.docx`)
- **LibreOffice** (`.odt`) — usado **como está**: o documento gerado também sai em `.odt`, e o PDF é
  feito direto pelo LibreOffice (sem passar por Word), o que preserva melhor imagens de fundo.
  Modelos de LibreOffice no formato de *modelo* (`.ott`) não são aceitos — salve como `.odt`.

Para gerar **PDF** é preciso ter o LibreOffice instalado no computador.

## Como escrever os campos

Escreva o campo entre chaves, **digitando de uma vez só** (sem mudar a formatação no meio do campo):
`{customer_name}`. Campos ausentes aparecem em branco.

| Quero… | Escreva |
|---|---|
| Mostrar um valor | `{total}` |
| Repetir um trecho para cada item de uma lista | `{#items} … {/items}` |
| Mostrar um trecho só quando algo existe/é verdadeiro | `{#credit_used} … {/credit_used}` |
| Mostrar um trecho só quando algo **não** existe | `{^has_discount} … {/has_discount}` |

Exemplos:

```
{#installments}
Parcela {number} — vence {due_date} — {amount}
{/installments}
```

Para a linha de desconto **sumir por inteiro** quando não há desconto, coloque a abertura e o
fechamento **cada um na sua própria linha**:

```
{#has_discount}
Desconto: {discount_total}
{/has_discount}
Total: {total}
```

Dicas:
- **Marcadores na própria linha** (abertura sozinha em uma linha e fechamento sozinho em outra)
  repetem ou **removem as linhas do meio** — é assim que a linha de desconto some e que uma lista vira
  uma linha por item.
- **Marcadores dentro da mesma linha** (`{#has_discount}Desconto {discount_total}{/has_discount}`)
  funcionam "em linha": o texto some quando a condição é falsa, mas **a linha em branco fica**, e uma
  lista (`{#items}{name}{/items}`) sai toda na mesma linha.
- Para repetir uma **linha de tabela**, coloque a abertura (`{#items}`) em uma célula da linha e o
  fechamento (`{/items}`) em outra célula da **mesma linha**.
- O comportamento é o mesmo em modelos `.docx` e `.odt`.
- Dentro de uma lista, os campos do item vêm primeiro; se um campo não existir ali, é usado o do
  documento. Listas podem ficar dentro de listas (ex.: `{#additionals}` dentro de `{#items}`).

## Campos do cliente (todos os documentos)

`{customer_name}` nome · `{customer_nickname}` apelido · `{customer_document}` CPF/CNPJ ·
`{customer_email}` e-mail · `{customer_phone}` telefone · `{customer_whatsapp}` WhatsApp ·
`{customer_address}` endereço · `{customer_neighborhood}` bairro · `{customer_city}` cidade ·
`{customer_uf}` estado

## Contrato (contrato único)

| Campo | O que é |
|---|---|
| `{contract_number}` | Número do contrato (ex.: `26/001`) |
| `{contract_type}` | "Contrato" ou "Fatura" |
| `{title}` | Título do contrato |
| `{execution_date}` `{execution_time}` `{execution_address}` | Data, hora e endereço de execução |
| `{comments}` | Comentários |
| `{service_name}` `{service_base_price}` `{service_total}` | Serviço do contrato: nome, preço base e total (com adicionais e desconto) |
| `{quantity}` `{duration}` `{discount_percent}` | Quantidade, duração e desconto (%) do serviço |
| `{#additionals}` … `{/additionals}` | Adicionais do serviço: `{name}` `{quantity}` `{unit_price}` `{line_total}` |
| `{#items}` … `{/items}` | Os itens como lista (veja "Itens" abaixo) |
| `{#modifiers}` … `{/modifiers}` | Modificadores: `{name}` `{price}` `{discount_percent}` `{line_total}` |
| `{date}` `{date_long}` | Data de geração por extenso (ex.: `07 de Agosto de 2026`) |
| `{date_short}` | Data de geração em `dd/mm/aaaa` |

## Fatura (contrato recorrente)

| Campo | O que é |
|---|---|
| `{contract_number}` | Número do contrato recorrente (ex.: `F001`) |
| `{title}` | Título do contrato |
| `{invoice_reference}` | Referência da fatura (ex.: `Agosto/2026`) |
| `{invoice_number}` | Número sequencial da fatura (ex.: `001-26`) |
| `{comments}` | Comentários da fatura |
| `{discount_percent}` | Desconto percentual da fatura |
| `{#items_summary}` … `{/items_summary}` | **Resumo**: o mesmo serviço (com os mesmos adicionais) numa linha só, com quantidade e total somados. Campos: `{item_number}` `{service_name}` `{quantity}` `{base_price}` `{total}` e `{#additionals}` |
| `{#items}` … `{/items}` | **Detalhe**: um serviço realizado por linha (veja "Itens" abaixo) |
| `{#modifiers}` … `{/modifiers}` | Modificadores da fatura |
| `{date}` `{date_long}` `{date_short}` | Data de geração (por extenso / `dd/mm/aaaa`) |

Uma fatura costuma ter o **resumo** na primeira página (`{#items_summary}`) e a **lista com descrições**
na segunda (`{#items}`).

## Itens (`{#items}`)

| Campo | O que é |
|---|---|
| `{item_number}` | Número sequencial (1, 2, 3…) — só nas faturas |
| `{service_name}` | Nome do serviço |
| `{description}` | Descrição (ex.: título do vídeo) |
| `{performed_at}` | Data de realização — só nas faturas |
| `{quantity}` | Quantidade |
| `{base_price}` | Preço unitário |
| `{base_total}` | Preço unitário × quantidade (**sem** adicionais) |
| `{line_total}` | Total do item (**com** adicionais) |
| `{#additionals}` … `{/additionals}` | Adicionais: `{name}` `{quantity}` `{unit_price}` `{line_total}` |

## Valores, desconto e crédito (contrato e fatura)

| Campo | O que é |
|---|---|
| `{subtotal}` | Valor base + modificadores, **sem nenhum desconto** |
| `{discount_total}` | Soma de **todos** os descontos (itens, adicionais, desconto da fatura e modificadores) |
| `{has_discount}` | Verdadeiro quando há desconto — use `{#has_discount} … {/has_discount}` |
| `{total}` | Valor **a pagar**, já com o crédito descontado |
| `{total_before_credit}` | Valor antes do crédito (= `{subtotal}` − `{discount_total}`) |
| `{credit_used}` | Verdadeiro quando um crédito foi usado — use `{#credit_used} … {/credit_used}` |
| `{credit_description}` | Descrição do crédito usado |
| `{credit_applied}` | Valor do crédito, **negativo** (ex.: `-R$ 300,00`) |
| `{total_after_credit}` | Igual a `{total}` |

## Parcelas (contrato e fatura)

`{installments_count}` número de parcelas. Lista: `{#installments} … {/installments}` com `{number}`
(apenas o número da parcela: 1, 2, 3…), `{due_date}` e `{amount}`.

## Recibo

| Campo | O que é |
|---|---|
| `{contract_number}` | Número do contrato ligado (se houver) |
| `{service_name}` | Nome do serviço (título do contrato) |
| `{invoice_reference}` `{invoice_number}` | Referência e número da fatura (contratos recorrentes) |
| `{description}` | Descrição do pagamento |
| `{amount}` | Valor recebido |
| `{amount_left}` | O que ainda falta receber **daquela fatura** (ou daquele contrato único) |
| `{installment}` | Parcela (ex.: `1/3`) |
| `{due_date}` | Vencimento da parcela |
| `{date}` `{date_long}` | Data do recebimento por extenso |
| `{date_short}` | Data do recebimento em `dd/mm/aaaa` |

## Qual modelo cada contrato usa

Ao criar ou editar um contrato é **obrigatório escolher** os modelos: o de contrato (contrato único) ou
o de fatura (recorrente), e o de **recibo**. Pode haver vários modelos de cada tipo. Um modelo em uso
não pode ser excluído — use **Substituir** para trocar o arquivo mantendo os vínculos.
