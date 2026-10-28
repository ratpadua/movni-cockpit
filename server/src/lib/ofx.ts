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
}

function tag(block: string, name: string): string | null {
  // Matches <NAME>value  (SGML, value ends at newline or next tag)
  // and <NAME>value</NAME> (XML).
  const re = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : null;
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

  for (const block of rawBlocks) {
    const amountStr = tag(block, 'TRNAMT');
    if (amountStr === null) continue;
    const amount = Number(amountStr.replace(',', '.'));
    if (Number.isNaN(amount)) continue;

    transactions.push({
      fitId: tag(block, 'FITID'),
      trnType: tag(block, 'TRNTYPE'),
      date: parseOfxDate(tag(block, 'DTPOSTED')),
      amount,
      name: tag(block, 'NAME'),
      memo: tag(block, 'MEMO'),
    });
  }

  return { bankId, accountId, transactions };
}
