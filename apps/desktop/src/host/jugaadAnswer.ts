/**
 * Deterministic answer text for a JUGAAD household question. Built only from what the read-only
 * `jugaad_*` tools returned: no model hop, so no figure can be invented or mis-added.
 */
export interface JugaadAnswerInput {
  pulse?: string | null;
  expenses?: string | null;
  vault?: string | null;
  /** Per-read failure text, shown instead of data. */
  errors?: { pulse?: string; expenses?: string; vault?: string };
  period?: { from: string; to: string };
}

function parse(raw: string | null | undefined): Record<string, any> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? v as Record<string, any> : null;
  } catch {
    return null;
  }
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function composeJugaadAnswer(input: JugaadAnswerInput): string {
  const lines: string[] = [];
  const errors = input.errors ?? {};

  if (input.pulse !== undefined || errors.pulse) {
    const p = parse(input.pulse);
    if (p) {
      const bits = [`status ${p.status}`, p.headline ? `"${p.headline}"` : null,
        typeof p.projectedAmount === 'number' ? `${p.projectedLabel ?? 'projected'} ${money(p.projectedAmount)}` : null,
        typeof p.daysLeft === 'number' ? `${p.daysLeft} days left in the cycle` : null].filter(Boolean);
      lines.push(`Household Pulse: ${bits.join(' · ')}.`);
      if (p.topRisk) lines.push(`Top risk: ${p.topRisk}.`);
      if (p.upcoming) lines.push(`Upcoming: ${p.upcoming}.`);
    } else lines.push(`Household Pulse: unavailable — ${errors.pulse ?? 'no data returned'}.`);
  }

  if (input.expenses !== undefined || errors.expenses) {
    const e = parse(input.expenses);
    const s = e?.summary;
    if (e && s) {
      const sums = Object.entries(s.sumOfAmountsByCurrency ?? {}).map(([c, v]) => `${money(Number(v))} ${c}`).join(', ') || 'no amounts';
      const range = input.period ? ` ${input.period.from} to ${input.period.to}` : '';
      lines.push(`Spending${range}: ${s.transactionsCounted} counted transactions (${s.excludedTransactions} excluded), sum of recorded amounts ${sums}. ${s.complete ? 'Covers every transaction in the period.' : String(s.note)}`);
    } else lines.push(`Spending: unavailable — ${errors.expenses ?? 'no data returned'}.`);
  }

  if (input.vault !== undefined || errors.vault) {
    const v = parse(input.vault);
    if (v) {
      const cats = Object.entries(v.byCategory ?? {}).map(([k, n]) => `${k} ${n}`).join(', ');
      lines.push(`Vault: ${v.total} documents${cats ? ` (${cats})` : ''}; recovered receipts: ${v.recoveredReceipts ?? 0}.`);
    } else lines.push(`Vault: unavailable — ${errors.vault ?? 'no data returned'}.`);
  }

  lines.push('Read live from your phone through the read-only JUGAAD bridge.');
  return lines.join('\n');
}
