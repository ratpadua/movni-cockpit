import type { FastifyReply } from 'fastify';

// Small shared input-validation helpers. They only check shape/format (no business
// rules). Callers answer 400 with a pt-BR message when one of them returns null.

// Allowed values come from db/schema.ts so they cannot drift.
import {
  FLOWS,
  PAYMENT_STATUS as PAYMENT_STATUSES,
  RECEIPT_STATUS as RECEIPT_STATUSES,
  CONTRACT_TYPES,
  CONTACT_METHODS,
} from '../db/schema.js';
export { FLOWS, PAYMENT_STATUSES, RECEIPT_STATUSES, CONTRACT_TYPES, CONTACT_METHODS };

export function isOneOf<T extends readonly string[]>(list: T, v: unknown): v is T[number] {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

// A positive integer id from a route param or body field; null when it is NaN,
// fractional, <= 0 or not a number/numeric string.
export function parseId(v: unknown): number | null {
  if (typeof v === 'string' && !/^\d+$/.test(v.trim())) return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

// A money value (a number or a numeric string) rounded to cents. Null when it is not
// a finite number or does not fit DECIMAL(12,2). Negative values are allowed (the UI
// does not forbid them). `emptyAs` turns ''/null/undefined into that value instead of
// failing.
export function parseMoney(v: unknown, opts: { emptyAs?: number } = {}): number | null {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    return opts.emptyAs ?? null;
  }
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const s = v.trim();
    // Accept "1234.56" and the pt-BR decimal comma "1234,56" (no thousands separators).
    if (!/^-?\d+([.,]\d+)?$/.test(s)) return null;
    n = Number(s.replace(',', '.'));
  } else return null;
  if (!Number.isFinite(n) || Math.abs(n) >= 1e10) return null;
  return Math.round(n * 100) / 100;
}

// A real calendar date in yyyy-mm-dd form (rejects 2026-02-31, 2026-13-01, ...);
// returns the string or null.
export function parseIsoDateStrict(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2999) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? v : null;
}

// Optional date field: undefined stays undefined, ''/null become null, otherwise a
// valid calendar date or `false` (invalid).
export function optionalDate(v: unknown): string | null | undefined | false {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return parseIsoDateStrict(v) ?? false;
}

// Optional integer id field: same convention as optionalDate.
export function optionalId(v: unknown): number | null | undefined | false {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return parseId(v) ?? false;
}

export function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

export function badId(reply: FastifyReply) {
  return badRequest(reply, 'Identificador inválido.');
}
