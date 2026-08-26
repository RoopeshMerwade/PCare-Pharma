import Button from './Button';
import { count as formatCount } from '../lib/format';

/* ═══════════════════════════════════════════════════════════════════════════
   Pagination — the windowing logic previously defined inside MedicinesPage and
   copied by eye elsewhere, extracted once.

   The window matters for a reason recorded in the original code: a catalogue
   of a few thousand medicines rendered one button per page, which stretched
   the page tall enough to drag the sidebar with it. A bounded window keeps
   the control a fixed size whatever the row count.
   ═══════════════════════════════════════════════════════════════════════════ */

/** First, last, and the current page ±1, with gaps marked. */
export function pageWindow(current, total) {
  const pages = [1];
  for (let p = current - 1; p <= current + 1; p += 1) {
    if (p > 1 && p < total) pages.push(p);
  }
  if (total > 1) pages.push(total);

  const withGaps = [];
  let prev = 0;
  for (const p of [...new Set(pages)].sort((a, b) => a - b)) {
    if (prev && p - prev > 1) withGaps.push('gap');
    withGaps.push(p);
    prev = p;
  }
  return withGaps;
}

export default function Pagination({ page, pages, total, limit, onPageChange, itemNoun = 'items' }) {
  if (!pages || pages <= 1) return null;

  const first = (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);

  return (
    <nav
      className="mt-s5 flex flex-wrap items-center justify-between gap-s3"
      aria-label="Pagination"
    >
      <p className="text-base text-muted-foreground">
        Showing {formatCount(first)}–{formatCount(last)} of {formatCount(total)} {itemNoun}
      </p>

      <div className="flex items-center gap-s1">
        <Button
          variant="secondary"
          size="compact"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          Previous
        </Button>

        {pageWindow(page, pages).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} className="px-s1 text-base text-muted-foreground" aria-hidden="true">
              …
            </span>
          ) : (
            <Button
              key={p}
              variant={p === page ? 'primary' : 'ghost'}
              size="icon"
              onClick={() => onPageChange(p)}
              aria-label={`Page ${p}`}
              aria-current={p === page ? 'page' : undefined}
            >
              <span className="tabular">{p}</span>
            </Button>
          )
        )}

        <Button
          variant="secondary"
          size="compact"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pages}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
