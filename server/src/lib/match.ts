// Suggestion engine that matches a bank transaction to an existing payment,
// primarily by amount (exact) and secondarily by name similarity.

export interface MatchablePayment {
  id: number;
  description: string;
  amount: number;
  customerName?: string | null;
}

export interface MatchCandidate {
  paymentId: number;
  score: number; // 0..1
  reason: string;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token-overlap similarity (Jaccard-ish) — cheap and good enough for names.
function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normalize(a).split(' ').filter(Boolean));
  const tb = new Set(normalize(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

/**
 * Rank payments as match candidates for a single transaction.
 * @param txName   transaction NAME/MEMO text
 * @param txAmount transaction amount (absolute value compared)
 */
export function suggestMatches(
  txName: string,
  txAmount: number,
  payments: MatchablePayment[],
  limit = 5
): MatchCandidate[] {
  const absTx = Math.abs(txAmount);

  const scored = payments.map((p) => {
    const amountMatch = Math.abs(Math.abs(p.amount) - absTx) < 0.005;
    const haystack = `${p.description} ${p.customerName ?? ''}`;
    const nameScore = nameSimilarity(txName, haystack);

    // Amount exactness dominates; name breaks ties.
    let score = 0;
    let reason = '';
    if (amountMatch) {
      score = 0.7 + 0.3 * nameScore;
      reason = nameScore > 0.3 ? 'valor + nome' : 'valor exato';
    } else {
      score = 0.5 * nameScore;
      reason = 'nome semelhante';
    }
    return { paymentId: p.id, score, reason };
  });

  return scored
    .filter((c) => c.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
