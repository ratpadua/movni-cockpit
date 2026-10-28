import type { Payment } from '../api/client';
import { todayIso } from './dates';

type PaymentLike = Pick<Payment, 'flow' | 'status' | 'receiptStatus' | 'dueDate'>;

// Still unsettled (Aberto / A pagar, and therefore also Atrasado):
//  - entrada: receipt not yet received      -> receiptStatus === 'open'
//  - saída:   cost not yet paid             -> status === 'upcoming'
// Note: `status` alone can't be used for entradas — it defaults to 'upcoming'
// even after the money is received.
export function isPaymentOpen(p: PaymentLike): boolean {
  return p.flow === 'in' ? p.receiptStatus === 'open' : p.status === 'upcoming';
}

// "Atrasado" is derived, never stored: the app isn't open at all times, so there
// is no reliable moment to flip a stored status. A payment is late when it is
// still open and its due date is before today (due today is still open).
export function isPaymentLate(p: PaymentLike, today = todayIso()): boolean {
  if (!p.dueDate || p.dueDate >= today) return false;
  return isPaymentOpen(p);
}

export type PaymentSituation = { label: string; color: string };

const RECEIPT: Record<string, PaymentSituation> = {
  open: { label: 'Aberto', color: 'yellow' },
  received: { label: 'Recebido', color: 'teal' },
  sent: { label: 'Enviado', color: 'blue' },
};

// Badge label/color for a payment's Situação, with Atrasado taking precedence.
export function paymentSituation(p: Payment, today = todayIso()): PaymentSituation {
  if (isPaymentLate(p, today)) return { label: 'Atrasado', color: 'red' };
  if (p.flow === 'in') return RECEIPT[p.receiptStatus] ?? RECEIPT.open;
  return p.status === 'done' ? { label: 'Pago', color: 'blue' } : { label: 'A pagar', color: 'yellow' };
}
