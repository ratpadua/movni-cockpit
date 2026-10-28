import { ContractStatus, AppSettings } from '../api/client';

// One-time contract workflow (order matters — transitions move one step).
export const CONTRACT_STATUSES: ContractStatus[] = [
  'aguardando_pagamento',
  'agendado',
  'realizado',
  'em_edicao',
  'enviado',
  'finalizado',
];

export const STATUS_LABELS: Record<ContractStatus, string> = {
  aguardando_pagamento: 'Aguardando pagamento',
  agendado: 'Agendado',
  realizado: 'Realizado',
  em_edicao: 'Em edição',
  enviado: 'Enviado',
  finalizado: 'Finalizado',
};

export const STATUS_COLORS: Record<ContractStatus, string> = {
  aguardando_pagamento: 'yellow',
  agendado: 'blue',
  realizado: 'cyan',
  em_edicao: 'grape',
  enviado: 'indigo',
  finalizado: 'green',
};

// Days window (SLA) for a status, from settings. null = no deadline.
export function windowDays(status: ContractStatus, s?: AppSettings): number | null {
  if (status === 'em_edicao') return s?.editWindowDays ?? 20;
  if (status === 'enviado') return s?.previewWindowDays ?? 30;
  return null;
}

export function statusDeadline(status: ContractStatus, statusChangedAt: string, s?: AppSettings): Date | null {
  const days = windowDays(status, s);
  if (days == null || !statusChangedAt) return null;
  const d = new Date(statusChangedAt);
  d.setDate(d.getDate() + days);
  return d;
}

export function isOverdue(status: ContractStatus, statusChangedAt: string, s?: AppSettings): boolean {
  const dl = statusDeadline(status, statusChangedAt, s);
  return dl != null && Date.now() > dl.getTime();
}

export const nextStatus = (st: ContractStatus): ContractStatus | null => {
  const i = CONTRACT_STATUSES.indexOf(st);
  return i >= 0 && i < CONTRACT_STATUSES.length - 1 ? CONTRACT_STATUSES[i + 1] : null;
};
export const prevStatus = (st: ContractStatus): ContractStatus | null => {
  const i = CONTRACT_STATUSES.indexOf(st);
  return i > 0 ? CONTRACT_STATUSES[i - 1] : null;
};
