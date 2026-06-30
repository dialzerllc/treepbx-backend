// Pure helpers for outbound caller-ID selection. Kept dependency-free so
// they can be unit-tested without bootstrapping the DB client / env.

// North-American area code derived from the dialed number, used by the
// `local_match` strategy. For US/Canada E.164 (+1NXXNXXXXXX) we skip the
// country code and read 3 digits; for other formats we best-effort with
// the first three digits after stripping non-digits.
export function npaOf(rawNumber: string): string {
  const d = rawNumber.replace(/\D/g, '');
  return d.startsWith('1') ? d.slice(1, 4) : d.slice(0, 3);
}

// Stateless DID picker. The caller hands in a sorted list of candidates
// (deterministic order, e.g. `ORDER BY created_at`) plus the strategy and
// the number being dialed; the function picks one.
//
// `round_robin` / `sequential` would need rotation state across calls, so
// at this layer they collapse to "first candidate" — callers that want
// real rotation maintain their own counter (see esl/dialer.ts).
export function applyCidStrategy<T extends { number: string }>(
  candidates: T[],
  strategy: string,
  dialedNumber: string | null,
): T | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  switch (strategy) {
    case 'random':
      return candidates[Math.floor(Math.random() * candidates.length)];
    case 'local_match': {
      if (!dialedNumber) return candidates[0];
      const targetNpa = npaOf(dialedNumber);
      const match = candidates.find((c) => npaOf(c.number) === targetNpa);
      return match ?? candidates[0];
    }
    case 'round_robin':
    case 'sequential':
    case 'fixed':
    default:
      return candidates[0];
  }
}
