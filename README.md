# Movni Cockpit

**[English](#english) · [Português](#português)**

---

<a id="english"></a>

## English

Management system for **Movni** (a photography business): customers, services, contracts and
invoices, cash flow, receipts and bank-statement import — all in one place.

It runs **locally on each computer** (you just open it in the browser) and uses a **hosted MySQL
database shared by all machines**. Everyone sees the same data, and no server of your own is needed.

> The interface is entirely in **Brazilian Portuguese**.

### What it does

#### Dashboard ("Painel")
An overview: how much is **to receive** and **to pay**, number of customers, **late payments** and
**late contracts** (each one links straight to its contract), plus the list of upcoming open payments.

#### Customers
Full records (name, nickname, tax ID, contacts, address). Each customer also has:
- **Credits** — balances that can be used to reduce the value of contracts and invoices;
- **Pending charges** — everything still open for that customer.

#### Services
A catalogue of services with a base price and **additionals**. Services are versioned: changing a
price never alters contracts that were already made.

#### Contracts
Two kinds:
- **One-time contract** — one service, with value, discounts, modifiers, installments, customer
  credit, and a **status workflow** (Aguardando pagamento → Agendado → Realizado → Em edição →
  Enviado → Finalizado), with configurable deadlines for *Em edição* and *Enviado* and a late alert;
- **Recurring contract** — performed services are logged over time and then **invoiced**. Invoices
  have their own number, discount, modifiers, credit and installments, and can be edited as long as
  no installment has been received.

Each contract chooses which document **templates** it uses (contract/invoice and receipt).

#### Documents and receipts
Generates the contract, invoice and receipt from **templates you create yourself** in Word (`.docx`)
or LibreOffice (`.odt`), filling in fields such as `{customer_name}` and `{total}`. The full list of
available fields is shown on the **Modelos** screen. Documents can be downloaded in their original
format or as **PDF**.

#### Cash flow ("Fluxo de Caixa")
Every inflow and outflow, **month by month** by default (longer periods are available). It shows each
entry's status (**Aberto, A pagar, Atrasado, Recebido, Enviado, Pago**), offers filters by status,
customer, contract and category, lets you edit entries, and lets you record **extra payments** tied to
a contract (without changing the contract's original value). **Receipts** are generated from here too.

#### Bank statements
Imports **OFX** files, shows an editable preview, suggests reconciliation with open payments (by
amount and name), and lets you link an incoming payment to a contract. Lines that were **already
imported** are flagged and unticked by default, to avoid duplicates.

#### Reports, Categories and Appearance
- **Reports** of realized inflows and outflows by period, type and category;
- **Categories** to classify entries;
- **Appearance**: menu and button colors, logo, and the contract status deadlines.

### How to run it

#### To use it (portable bundle — Windows)

Nothing needs to be installed.

1. Extract the **whole** `.zip` to a folder you can write to (for example
   `C:\Users\YOUR_USER\movni-cockpit`). Do not run it from inside the `.zip`.
2. Double-click **`start.cmd`**. The browser opens at <http://localhost:5178>; if it doesn't, type that
   address in.
3. **Sign in with the database user and password** (provided separately). They are not saved on the
   computer: they are asked for every time the program is opened.

To quit, close the black `start.cmd` window.

Requirements and notes:
- You need **internet** (the database is on Hostinger), and the computer's **public IP** must be
  allow-listed under *Remote MySQL* in the Hostinger panel — otherwise sign-in fails.
- To download documents as **PDF**, install **LibreOffice** (free, at libreoffice.org). Without it,
  documents are still generated normally as Word/LibreOffice files.
- Generated documents are stored in the `storage/contracts/` folder **of the computer that generated
  them**.

#### From the source code

Requires Node.js. From the project folder:

```bash
npm run install:all          # install dependencies (root, server and client)
cp .env.example .env         # set the database server and name (no user/password)
npm start                    # build the interface and serve everything at http://localhost:5178
```

For development, with automatic reload (interface at <http://localhost:5173>):

```bash
npm run dev
```

The **database user and password are typed on the system's sign-in screen** — they never live in
`.env`. The database commands (`db:migrate`, `db:seed`) use a local `.env.local` file, which is not
version-controlled or distributed.

### Technologies

React + TypeScript + Vite + Mantine (interface) · Node + Fastify (local API, also serves the
interface) · Drizzle ORM + MySQL on Hostinger · docxtemplater and a purpose-built engine for `.odt`
templates · LibreOffice for PDF export.

### For developers

Development rules, conventions, business rules, and the packaging and production-migration steps are
in [`CLAUDE.md`](CLAUDE.md).

---

<a id="português"></a>

## Português

Sistema de gestão para a **Movni** (fotografia): clientes, serviços, contratos e faturas, fluxo de
caixa, recibos e importação de extratos bancários — tudo em um só lugar.

Ele roda **localmente em cada computador** (basta abrir no navegador) e usa um **banco de dados
MySQL hospedado, compartilhado entre as máquinas**. Assim, todos veem os mesmos dados, sem precisar
de um servidor próprio.

> A interface é toda em **português do Brasil**.

### O que o sistema faz

#### Painel
Visão geral: quanto há **a receber** e **a pagar**, número de clientes, **pagamentos atrasados** e
**contratos atrasados** (com acesso direto ao contrato), além da lista dos próximos pagamentos em aberto.

#### Clientes
Cadastro completo (nome, apelido, documento, contatos, endereço). Cada cliente tem:
- **Créditos** — saldos que podem ser usados para abater o valor de contratos e faturas;
- **Cobranças pendentes** — tudo o que ainda está em aberto para aquele cliente.

#### Serviços
Catálogo de serviços com preço base e **adicionais**. Os serviços são versionados: mudar o preço não
altera contratos já feitos.

#### Contratos
Dois tipos:
- **Contrato único** — um serviço, com valor, descontos, modificadores, parcelas, crédito do cliente e
  um **fluxo de status** (Aguardando pagamento → Agendado → Realizado → Em edição → Enviado →
  Finalizado), com prazos configuráveis para *Em edição* e *Enviado* e alerta de atraso;
- **Contrato recorrente** — os serviços realizados vão sendo registrados e depois **faturados**.
  As faturas têm número próprio, desconto, modificadores, crédito, parcelas e podem ser editadas
  enquanto nenhuma parcela foi recebida.

Cada contrato escolhe os **modelos** de documento que usa (contrato/fatura e recibo).

#### Documentos e recibos
Gera o contrato, a fatura e o recibo a partir de **modelos que você mesmo cria** no Word (`.docx`) ou
no LibreOffice (`.odt`), preenchendo campos como `{customer_name}` e `{total}`. A lista completa de
campos disponíveis aparece na tela **Modelos**. Os documentos podem ser baixados no formato original
ou em **PDF**.

#### Fluxo de Caixa
Todas as entradas e saídas, por padrão **mês a mês** (com opção de períodos maiores). Mostra a
situação de cada lançamento (**Aberto, A pagar, Atrasado, Recebido, Enviado, Pago**), tem filtros
por situação, cliente, contrato e categoria, permite editar lançamentos e registrar **pagamentos
extras** ligados a um contrato (sem alterar o valor original dele). Daqui também saem os **recibos**.

#### Extratos bancários
Importa arquivos **OFX**, mostra uma pré-visualização editável, sugere a conciliação com pagamentos
em aberto (por valor e nome) e permite associar uma entrada a um contrato. Linhas **já importadas
antes** vêm sinalizadas e desmarcadas, para evitar duplicidade.

#### Relatórios, Categorias e Aparência
- **Relatórios** de entradas e saídas realizadas, por período, tipo e categoria;
- **Categorias** para classificar lançamentos;
- **Aparência**: cores do menu e dos botões, logotipo e os prazos dos status dos contratos.

### Como rodar

#### Para usar (pacote portátil — Windows)

Não precisa instalar nada.

1. Extraia **toda** a pasta do `.zip` para um local com permissão de escrita (por exemplo
   `C:\Users\SEU_USUARIO\movni-cockpit`). Não rode de dentro do arquivo `.zip`.
2. Dê um duplo clique em **`start.cmd`**. O navegador abre em <http://localhost:5178>; se não abrir,
   digite esse endereço.
3. **Entre com o usuário e a senha do banco de dados** (fornecidos separadamente). Eles não ficam
   salvos no computador: são pedidos toda vez que o programa é aberto.

Para encerrar, feche a janela preta do `start.cmd`.

Requisitos e observações:
- É preciso **internet** (o banco fica na Hostinger) e o **IP público do computador** precisa estar
  liberado no *MySQL Remoto* do painel da Hostinger — sem isso o login falha.
- Para baixar documentos em **PDF**, instale o **LibreOffice** (gratuito, em libreoffice.org). Sem ele,
  os documentos continuam sendo gerados normalmente em Word/LibreOffice.
- Os documentos gerados ficam na pasta `storage/contracts/` **do computador que os gerou**.

#### A partir do código-fonte

Requer Node.js. Na pasta do projeto:

```bash
npm run install:all          # instala as dependências (raiz, server e client)
cp .env.example .env         # informe o servidor e o nome do banco (sem usuário/senha)
npm start                    # compila a interface e sobe tudo em http://localhost:5178
```

Para desenvolver, com recarga automática (interface em <http://localhost:5173>):

```bash
npm run dev
```

O **usuário e a senha do banco são digitados na tela de login** do sistema — nunca ficam no `.env`.
Os comandos de banco (`db:migrate`, `db:seed`) usam um arquivo local `.env.local`, que não é versionado
nem distribuído.

### Tecnologias

React + TypeScript + Vite + Mantine (interface) · Node + Fastify (API local, também serve a interface)
· Drizzle ORM + MySQL na Hostinger · docxtemplater e um motor próprio para modelos `.odt` ·
LibreOffice para exportar PDF.

### Para quem desenvolve

As regras de desenvolvimento, as convenções, as regras de negócio e os passos de empacotamento e de
migração de produção estão em [`CLAUDE.md`](CLAUDE.md).
