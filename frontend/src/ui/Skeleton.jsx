import { cn } from '../lib/cn';
import Card, { CardBody } from './Card';

/* ═══════════════════════════════════════════════════════════════════════════
   Skeleton — the loading state for every region in the app.

   §3.3/§3.4/§3.7 all require the placeholder to match the layout it stands in
   for, so nothing reflows when the real content lands. A stack of grey bars in
   front of a page that resolves into four stat tiles, two charts and a table
   is not a skeleton: it is a different screen shown briefly, and the jump when
   it swaps is the exact thing a skeleton exists to prevent.

   So the pieces below mirror the components they replace, one for one:

     SkeletonText    a run of text lines
     SkeletonRows    ui/List's ListRow — the shape Table collapses to below md
     SkeletonTable   ui/Table, at both of its breakpoints
     SkeletonTile    domain/charts' StatTile, sparkline slot included
     SkeletonCard    ui/Card with a title and body copy
     SkeletonChart   ui/charts' ChartCard, holding its reserved height
     SkeletonFields  ui/Field label + control pairs
     SkeletonDetail  ui/List's ListField label/value pairs

   A page composes these inside the SAME grid and gap classes the loaded page
   uses — that is what actually pins the layout, since no skeleton component
   can know the grid it will be dropped into.

   Every bar is aria-hidden: a screen reader reading out a row of grey boxes is
   noise. The wait is announced ONCE per region, by SkeletonRegion (A10).
   `animate-pulse` is disabled app-wide under prefers-reduced-motion (A8).
   ═══════════════════════════════════════════════════════════════════════════ */

/** One bar. Every other export in this file is built out of it. */
export default function Skeleton({ className, ...props }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-control bg-border', className)}
      {...props}
    />
  );
}

/**
 * The announcement, and the only part of a skeleton assistive tech can see.
 *
 * Wrap the whole loading branch of a region in one of these — not each piece.
 * `aria-busy` states the condition; the sr-only line is what a screen reader
 * actually reads, so it names what is being waited for rather than saying
 * "loading" into the void.
 */
export function SkeletonRegion({ label, className, children, ...props }) {
  if (import.meta.env.DEV && !label) {
    throw new Error(
      'SkeletonRegion requires a `label` naming what is loading — "Loading today’s figures…". ' +
        'Every bar inside is aria-hidden, so without it the wait is completely silent for a ' +
        'screen reader (A10).'
    );
  }

  return (
    <div role="status" aria-busy="true" className={className} {...props}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/* Text does not set solid to the margin, and a skeleton that does reads as a
   block of blocks. These cycle so consecutive rows differ without anything
   random getting into a render. */
const TITLE_WIDTHS = ['w-1/2', 'w-2/5', 'w-3/5', 'w-1/3'];
const META_WIDTHS = ['w-2/3', 'w-3/5', 'w-1/2', 'w-2/5'];

/** A run of body copy. One line fills the width; several stay ragged. */
export function SkeletonText({ lines = 1, className }) {
  return (
    <div className={cn('flex flex-col gap-s1', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn('h-4', lines === 1 ? 'w-full' : META_WIDTHS[i % META_WIDTHS.length])}
        />
      ))}
    </div>
  );
}

/**
 * Rows, shaped like `ListRow` — bordered card, min 44px, title over meta, and
 * a trailing slot for the badge or figure that sits at the end of nearly every
 * row in this app. This is also the shape `Table` collapses into below `md`,
 * so one skeleton covers a list page at both breakpoints.
 */
export function SkeletonRows({ count = 5, leading = false, trailing = true, className }) {
  return (
    <div className={cn('flex flex-col gap-s2', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="flex min-h-target items-center gap-s3 rounded-card border border-border bg-card px-s3 py-s2"
        >
          {leading && <Skeleton className="h-9 w-9 shrink-0 rounded-pill" />}
          <div className="flex min-w-0 flex-1 flex-col gap-s1">
            <Skeleton className={cn('h-4', TITLE_WIDTHS[i % TITLE_WIDTHS.length])} />
            <Skeleton className={cn('h-4', META_WIDTHS[i % META_WIDTHS.length])} />
          </div>
          {trailing && <Skeleton className="h-5 w-20 shrink-0 rounded-pill" />}
        </div>
      ))}
    </div>
  );
}

/**
 * A table, shaped like `Table` at BOTH of its breakpoints: the header band and
 * rows inside the card chrome at `md+`, one stacked card per row below it. A
 * desktop-shaped placeholder on a phone is a reflow waiting to happen, which
 * is why this takes the column count rather than assuming three.
 *
 * Counts, not a column config — a skeleton has no labels to render, and taking
 * the real array would invite passing `render` functions that never run.
 */
export function SkeletonTable({ columns = 4, rows = 6, actions = false, stackedRows = 4, className }) {
  return (
    <div className={className}>
      {/* ── md+ : header band, then rows, inside the real table chrome ── */}
      <div className="hidden overflow-hidden rounded-card border border-border bg-card md:block">
        <div className="flex gap-s3 border-b border-border bg-muted px-s3 py-s2">
          {Array.from({ length: columns }, (_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
          {actions && <Skeleton className="h-4 w-20 shrink-0" />}
        </div>
        <div className="flex flex-col gap-s2 p-s3">
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-target w-full" />
          ))}
        </div>
      </div>

      {/* ── below md : the stacked card — a title over label/value pairs ── */}
      <div className="flex flex-col gap-s2 md:hidden">
        {Array.from({ length: stackedRows }, (_, i) => (
          <div key={i} className="rounded-card border border-border bg-card p-s3">
            <Skeleton className="h-4 w-1/2" />
            <div className="mt-s2 flex flex-col divide-y divide-border">
              {Array.from({ length: Math.max(columns - 1, 1) }, (_, f) => (
                <div key={f} className="flex items-baseline justify-between gap-s3 py-s1">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A KPI tile, shaped like `StatTile`: label, the figure, the 96×32 sparkline
 * slot beside it, and the sub/delta line under it. `trend` and `sub` are
 * separate props because a tile without a series (this week, this month) is
 * shorter, and a skeleton that reserves a line the tile will not have is the
 * same reflow in the other direction.
 */
export function SkeletonTile({ sub = true, trend = true, className }) {
  return (
    <Card className={className}>
      <CardBody className="flex flex-col gap-s1">
        <Skeleton className="h-4 w-2/5" />
        <div className="flex items-end justify-between gap-s3">
          <Skeleton className="h-7 w-24" />
          {trend && <Skeleton className="mb-1 h-8 w-24 shrink-0" />}
        </div>
        {sub && <Skeleton className="h-4 w-1/3" />}
      </CardBody>
    </Card>
  );
}

/** A card with a heading and some copy. `children` replaces the body outright. */
export function SkeletonCard({ title = true, lines = 3, className, children }) {
  return (
    <Card className={className}>
      <CardBody className="flex flex-col gap-s3">
        {title && <Skeleton className="h-5 w-1/3" />}
        {children ?? <SkeletonText lines={lines} />}
      </CardBody>
    </Card>
  );
}

/**
 * A chart card holding its reserved height, so the page does not grow by 260px
 * when the series lands. Mirrors `ChartCard`'s own padding (header px-s4 pt-s4,
 * body p-s4 pt-s3) rather than approximating it.
 */
export function SkeletonChart({ height = 260, subtitle = true, className }) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <div className="flex flex-col gap-s1 px-s4 pt-s4">
        <Skeleton className="h-5 w-2/5" />
        {subtitle && <Skeleton className="h-4 w-3/5" />}
      </div>
      <div className="p-s4 pt-s3">
        <Skeleton className="w-full rounded-control" style={{ height }} />
      </div>
    </Card>
  );
}

/**
 * Label-over-control pairs at the real control height (44px, A6), for a form
 * that has to fetch before it can render its fields.
 */
export function SkeletonFields({ count = 4, className }) {
  return (
    <div className={cn('flex flex-col gap-s4', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-s1">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-target w-full rounded-control" />
        </div>
      ))}
    </div>
  );
}

/**
 * Label/value pairs, shaped like `ListField` — the detail block inside a
 * drawer or a dialog, where the value is short and right-aligned.
 */
export function SkeletonDetail({ rows = 4, className }) {
  return (
    <div className={cn('flex flex-col divide-y divide-border', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-baseline justify-between gap-s3 py-s2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className={cn('h-4', TITLE_WIDTHS[i % TITLE_WIDTHS.length])} />
        </div>
      ))}
    </div>
  );
}
