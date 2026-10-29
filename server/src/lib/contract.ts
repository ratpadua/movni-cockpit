import fs from 'node:fs';
import path from 'node:path';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { renderOdt, isOdt } from './odt.js';
import { PROJECT_ROOT } from './paths.js';

const CONTRACTS_DIR = path.resolve(
  PROJECT_ROOT,
  process.env.CONTRACTS_DIR?.replace(/^\.\//, '') ?? 'storage/contracts'
);

export type TemplateKind = 'contract' | 'invoice';

export interface ContractData {
  // Values pulled from the customer + contract items, plus the comments popup.
  // The .docx template refers to these with {placeholders} and {#items}...{/items}.
  [key: string]: unknown;
}

export type DocFormat = 'docx' | 'odt';

export interface GeneratedContract {
  fileName: string;
  filePath: string;
  format: DocFormat;
}

// Which format a template/document file is, judged by its contents.
export function detectDocFormat(buf: Buffer): DocFormat | null {
  try {
    if (new PizZip(buf).file('word/document.xml')) return 'docx';
  } catch {
    return null;
  }
  return isOdt(buf) ? 'odt' : null;
}

export function docMime(format: DocFormat): string {
  return format === 'odt'
    ? 'application/vnd.oasis.opendocument.text'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

// Extension of a stored document file name, as a DocFormat (defaults to docx).
export function formatOfFileName(fileName: string): DocFormat {
  return /\.odt$/i.test(fileName) ? 'odt' : 'docx';
}

// File-name safe version of a name: accents are transliterated (í→i, ç→c), other
// special characters dropped, spaces become underscores. Shared by every generated
// file name (contract, fatura, receipt).
export function sanitize(name: string): string {
  return name
    .normalize('NFD') // split accented letters into base + combining mark
    .replace(/[̀-ͯ]/g, '') // drop the marks, keeping the base char (í→i, ç→c, ã→a)
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

const MONTHS_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

// Long-form Brazilian date, e.g. "07 de Agosto de 2026".
export function longDatePtBR(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')} de ${MONTHS_PT[d.getMonth()]} de ${d.getFullYear()}`;
}

// Parse a yyyy-mm-dd string into a local Date (null-safe).
export function parseIsoDate(s?: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Render a .docx template (provided as a Buffer, loaded from the DB) with the
 * given data and write the result to the contracts folder.
 */
// Render a .docx template to a buffer (no disk write).
function renderDocx(data: ContractData, templateBuffer: Buffer): Buffer {
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    // Any missing placeholder renders as empty instead of "undefined".
    nullGetter: () => '',
  });
  // Pass data as-is (objects/arrays like line items are needed for {#items} loops).
  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Render a template (Word .docx or LibreOffice .odt) with the data. The output
// keeps the template's own format — an .odt is never converted to .docx.
export function renderDocument(data: ContractData, templateBuffer: Buffer): { buffer: Buffer; format: DocFormat } {
  const format = detectDocFormat(templateBuffer);
  if (format === 'odt') return { buffer: renderOdt(templateBuffer, data), format };
  if (format === 'docx') return { buffer: renderDocx(data, templateBuffer), format };
  throw new Error('O modelo não é um arquivo .docx ou .odt válido.');
}

export function generateContract(
  data: ContractData,
  baseName: string,
  templateBuffer: Buffer
): GeneratedContract {
  const { buffer, format } = renderDocument(data, templateBuffer);
  fs.mkdirSync(CONTRACTS_DIR, { recursive: true });
  const fileName = `${sanitize(baseName)}.${format}`;
  const filePath = path.join(CONTRACTS_DIR, fileName);
  fs.writeFileSync(filePath, buffer);
  return { fileName, filePath, format };
}

export function contractsDir(): string {
  return CONTRACTS_DIR;
}
