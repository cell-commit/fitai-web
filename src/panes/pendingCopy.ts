import type { PendingProgram, ReviewConcern, ReviewVerdict } from '../types';

// Shared copy for the pending-proposal surfaces (the compact Week-pane card and
// the full proposal page). Kept in its own module so the page and the pane can
// both use it without importing each other.

export const SOURCE_LABEL: Record<PendingProgram['source'], string> = {
  generate: 'Newly generated week',
  amend: 'Amendment from your session feedback',
  coach: 'Change proposed by the coach',
};

export const UNREVIEWED_SUMMARY =
  'The independent safety review could not run — check this proposed plan yourself before approving.';

/** The reviewer verdict, or null when the review itself was unavailable. */
export function verdictOf(pending: PendingProgram): ReviewVerdict | null {
  return 'status' in pending.review ? null : pending.review;
}

/** One line of concern copy: "issue — suggestion". */
export function concernText(c: Pick<ReviewConcern, 'issue'> & { suggestion?: string }): string {
  return `${c.issue}${c.suggestion ? ` — ${c.suggestion}` : ''}`;
}

/** "1 caution" / "3 cautions" — the count shown on the compact card. */
export function cautionCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'caution' : 'cautions'}`;
}

/** "1 exercise" / "4 exercises". */
export function exerciseCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'exercise' : 'exercises'}`;
}
