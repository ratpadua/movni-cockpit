import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { renderDocument, docMime, longDatePtBR, parseIsoDate, sanitize, type DocFormat } from '../lib/contract.js';
import { contentDisposition } from '../lib/http.js';
import { badId, parseId } from '../lib/validate.js';
import { loadTemplateById } from './templates.js';
import { officeToPdf } from '../lib/pdf.js';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function registerReceiptRoutes(app: FastifyInstance) {
  // Generate + stream a receipt .docx for a received entrada, then mark it sent.
  app.post('/api/payments/:id/receipt', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badId(reply);
    const [p] = await db.select().from(schema.payments).where(eq(schema.payments.id, id));
    if (!p) return reply.code(404).send({ error: 'pagamento não encontrado' });
    if (p.flow !== 'in' || (p.receiptStatus !== 'received' && p.receiptStatus !== 'sent')) {
      return reply.code(400).send({ error: 'marque o recibo como recebido antes de gerar' });
    }

    const [customer] = p.customerId
      ? await db.select().from(schema.customers).where(eq(schema.customers.id, p.customerId))
      : [null];
    const [contract] = p.contractId
      ? await db.select().from(schema.contracts).where(eq(schema.contracts.id, p.contractId))
      : [null];

    // The receipt model is chosen per contract. With no explicit choice (older
    // contracts, or a payment without a contract) it only works when there is
    // exactly one receipt model, so we never silently pick the wrong one.
    let tpl: Buffer | null = await loadTemplateById(contract?.receiptTemplateId);
    if (!tpl) {
      const receiptTemplates = await db
        .select({ id: schema.templates.id })
        .from(schema.templates)
        .where(eq(schema.templates.kind, 'receipt'));
      if (receiptTemplates.length === 0) {
        return reply.code(400).send({ error: 'Nenhum modelo de recibo cadastrado. Adicione um em "Modelos".' });
      }
      if (receiptTemplates.length > 1) {
        return reply.code(400).send({
          error: contract
            ? 'Selecione o modelo de recibo neste contrato (editar contrato) antes de gerar o recibo.'
            : 'Este pagamento não tem contrato; associe-o a um contrato com modelo de recibo para gerar o recibo.',
        });
      }
      tpl = await loadTemplateById(receiptTemplates[0].id);
    }
    if (!tpl) {
      return reply.code(400).send({ error: 'Modelo de recibo não encontrado.' });
    }

    const [invoice] = p.invoiceId
      ? await db.select().from(schema.invoices).where(eq(schema.invoices.id, p.invoiceId))
      : [null];

    // Amount still owed = the entrada payments not yet received, limited to the
    // same scope as this receipt: the specific invoice when the payment belongs to
    // one (recurring contracts have many invoices), otherwise its contract.
    // The payment being receipted is already 'received', so it's excluded here.
    let amountLeft = 0;
    if (p.invoiceId || p.contractId) {
      const scope = p.invoiceId
        ? eq(schema.payments.invoiceId, p.invoiceId)
        : eq(schema.payments.contractId, p.contractId!);
      const open = await db
        .select({ amount: schema.payments.amount })
        .from(schema.payments)
        .where(and(scope, eq(schema.payments.flow, 'in'), eq(schema.payments.receiptStatus, 'open')));
      amountLeft = open.reduce((s, r) => s + Number(r.amount), 0);
    }

    const c = customer;
    const receiptDate = parseIsoDate(p.receivedDate) ?? new Date();
    const data = {
      customer_name: c?.name ?? '',
      customer_nickname: c?.nickname ?? '',
      customer_address: c?.address ?? '',
      customer_neighborhood: c?.neighborhood ?? '',
      customer_city: c?.city ?? '',
      customer_uf: c?.state ?? '',
      customer_email: c?.email ?? '',
      customer_phone: c?.phone ?? '',
      customer_whatsapp: c?.whatsapp ?? '',
      customer_document: c?.document ?? '',
      contract_number: contract?.number ?? '',
      service_name: contract?.title ?? '', // one-time contract title = service name
      invoice_reference: invoice?.reference ?? '', // recurring: the invoice's reference
      invoice_number: invoice?.refNumber ?? '', // recurring: sequential invoice number (001-26)
      description: p.description ?? '',
      amount: brl(Number(p.amount)),
      amount_left: brl(amountLeft), // remaining to receive on the contract after this receipt
      installment:
        p.installmentNumber && p.installmentCount ? `${p.installmentNumber}/${p.installmentCount}` : '',
      // Due date of this installment/payment (short pt-BR), if any.
      due_date: parseIsoDate(p.dueDate)?.toLocaleDateString('pt-BR') ?? '',
      // Receipt date = the date the payment was received. {date} is the long form
      // for compatibility; {date_short} is dd/MM/yyyy, {date_long} an explicit alias.
      date: longDatePtBR(receiptDate),
      date_long: longDatePtBR(receiptDate),
      date_short: receiptDate.toLocaleDateString('pt-BR'),
    };

    const asPdf = (req.query?.format ?? '') === 'pdf';

    // The receipt keeps its model's format (.docx or .odt).
    let rendered: { buffer: Buffer; format: DocFormat };
    try {
      rendered = renderDocument(data, tpl);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }

    // Convert to PDF on the fly if requested (nothing is saved to the project).
    let out = rendered.buffer;
    let ext: string = rendered.format;
    let mime = docMime(rendered.format);
    if (asPdf) {
      try {
        out = await officeToPdf(rendered.buffer, rendered.format);
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
      ext = 'pdf';
      mime = 'application/pdf';
    }

    // Generating the document marks the receipt as sent.
    if (p.receiptStatus !== 'sent') {
      await db.update(schema.payments).set({ receiptStatus: 'sent' }).where(eq(schema.payments.id, id));
    }

    // File name: recibo_{cliente}[_{parcela}] — no date.
    const cleanName = sanitize(c?.nickname || c?.name || 'cliente') || 'cliente';
    // Include the installment as "_1-3", "_2-3"… in the file name. A single payment
    // (no installment, or just 1 of 1) gets no suffix.
    const parcela =
      p.installmentNumber && p.installmentCount && p.installmentCount > 1
        ? `_${p.installmentNumber}-${p.installmentCount}`
        : '';
    const fileName = `recibo_${cleanName}${parcela}.${ext}`;
    reply.header('Content-Disposition', contentDisposition(fileName));
    reply.type(mime);
    return reply.send(out);
  });
}
