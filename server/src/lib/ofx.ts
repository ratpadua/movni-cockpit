// Minimal, dependency-free OFX parser.
// Handles both OFX 1.x (SGML) and OFX 2.x (XML) statement files by pulling the
// values we care about out of each <STMTTRN> block with tolerant regexes.

export interface OfxTransaction {
  fitId: string | null;
  trnType: string | null;
  date: string | null; // ISO yyyy-mm-dd
  amount: number;
  name: string | null;
  memo: string | null;
}

export interface ParsedOfx {
  bankId: string | null;
  accountId: string | null;
  transactions: OfxTransaction[];
  skipped: number; // <STMTTRN> blocks dropped because their amount was missing/unreadable
}

// The five predefined XML entities (OFX 2.x is XML; SGML 1.x files escape them too).
// `&amp;` is decoded last so "&amp;lt;" becomes the literal text "&lt;", not "<".
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(block: string, name: string): string | null {
  // Matches <NAME>value  (SGML, value ends at newline or next tag)
  // and <NAME>value</NAME> (XML).
  const re = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1].trim()) : null;
}

// Parse an OFX amount. OFX uses "." as the decimal point, but Brazilian exports are
// sometimes "1.234,56" or "1,234.56" or "-1234,56". The LAST separator is the decimal
// point when both appear; repeated separators are thousands separators; a lone
// separator followed by exactly 3 digits is ambiguous and rejected (null).
function parseAmount(raw: string): number | null {
  const s = raw.replace(/\s/g, '').replace(/^\+/, '');
  if (!/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const sign = s.startsWith('-') ? -1 : 1;
  const body = s.replace(/^-/, '');
  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    normalized = body.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    const count = body.split(',').length - 1;
    const tail = body.length - lastComma - 1;
    // A single comma + exactly 3 digits ("1,234") is ambiguous: refuse to guess.
    if (count === 1 && tail === 3) return null;
    normalized = count > 1 ? body.split(',').join('') : body.replace(',', '.');
  } else if (lastDot >= 0) {
    const count = body.split('.').length - 1;
    const tail = body.length - lastDot - 1;
    if (count === 1 && tail === 3) return null; // "1.234": ambiguous too
    normalized = count > 1 ? body.split('.').join('') : body;
  } else {
    normalized = body;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? sign * n : null;
}

function parseOfxDate(raw: string | null): string | null {
  if (!raw) return null;
  // OFX dates look like 20240131 or 20240131120000[-3:BRT]
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function parseOfx(content: string): ParsedOfx {
  const bankId = tag(content, 'BANKID');
  const accountId = tag(content, 'ACCTID');

  const transactions: OfxTransaction[] = [];
  const blocks = content.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];

  // Some SGML files omit closing </STMTTRN>; fall back to splitting on the tag.
  const rawBlocks =
    blocks.length > 0
      ? blocks
      : content
          .split(/<STMTTRN>/i)
          .slice(1)
          .map((b) => `<STMTTRN>${b}`);

  let skipped = 0;
  for (const block of rawBlocks) {
    const amountStr = tag(block, 'TRNAMT');
    const amount = amountStr === null ? null : parseAmount(amountStr);
    if (amount === null) {
      skipped++;
      continue;
    }

    transactions.push({
      fitId: tag(block, 'FITID'),
      trnType: tag(block, 'TRNTYPE'),
      date: parseOfxDate(tag(block, 'DTPOSTED')),
      amount,
      name: tag(block, 'NAME'),
      memo: tag(block, 'MEMO'),
    });
  }

  return { bankId, accountId, transactions, skipped };
}
