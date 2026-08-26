import { cn } from '../../lib/cn';
import { count as formatCount, qty as formatQty } from '../../lib/format';
import Button from '../../ui/Button';
import Field from '../../ui/Field';
import Input, { NumericInput } from '../../ui/Input';
import Badge from '../../ui/Badge';
import { Money } from '../../domain/Money';
import { ValidationBadge } from '../../domain/StatusBadge';
import { lineTitle, lineValue, partitionWarnings, totalContent, totalUnits, unitMargin, warningsForField } from '../../domain/invoice';

/* ═══════════════════════════════════════════════════════════════════════════
   InvoiceLineCard — one printed line, editable.

   A fieldset of Fields, not a spreadsheet grid. Two reasons, and the second is
   the real one:

   · It is the shape ReceivePurchaseModal already uses for exactly this data,
     so the two goods-inward paths look and behave the same.
   · Every value here is labelled, has its own error slot, and is reachable by
     Tab in reading order — for free. A grid of bare <input>s in <td>s gets you
     denser rows and costs you the label association (A5, A7) and a hand-rolled
     arrow-key model that then has to be right.

   Editing model: every keystroke is local, and the value is PERSISTED ON BLUR.
   Not on keystroke (a PATCH per character, each recomputing every warning), and
   not behind a Save button (a reviewer who forgets it loses the correction).
   Blur is when the person has finished with the field, which is exactly when
   the derived figures and badges should catch up.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Local-time YYYY-MM-DD. toISOString() is UTC and rolls the date backwards
 *  before 05:30 IST, which would let a batch expiring today pass as future. */
function isoToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** First message on a field, so it lands under the control that caused it. */
function fieldError(warnings, field) {
  const hits = warningsForField(warnings, field);
  const blocking = hits.find((w) => w.severity === 'error');
  return blocking?.message;
}

/** Advisories are shown as text under the field, not as a Field error — an
 *  amber note must not turn the control's border red. */
function fieldNote(warnings, field) {
  const hits = warningsForField(warnings, field);
  if (hits.some((w) => w.severity === 'error')) return null;
  return hits[0]?.message;
}

export default function InvoiceLineCard({
  line,
  readOnly = false,
  isOwner,
  onEdit,
  onSave,
  onOpenMatch,
  onOpenQuickAdd,
  onToggleExclude,
}) {
  const warnings = line.warnings || [];
  const { errors, advisories } = partitionWarnings(warnings);
  const units = totalUnits(line);
  const value = lineValue(line);
  const margin = unitMargin(line);
  const unit = line.medicines?.unit || 'units';
  // What one billed unit is on the shelf, and what is inside it. The contents
  // are shown, never multiplied — see the Pack column note in CLAUDE.md.
  const saleUnit = (line.sale_unit || '').toLowerCase() || unit.replace(/s$/, '');
  const contents = totalContent(line);

  // Local edit, then persist on blur — see the note above.
  const edit = (key) => (raw) => onEdit(line.id, { [key]: raw });
  const commit = (key, transform) => () => {
    const raw = line[key];
    const next = transform ? transform(raw) : raw;
    if (next !== raw) onEdit(line.id, { [key]: next });
    onSave(line.id, { [key]: next === '' ? null : next });
  };

  const toNumber = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

  return (
    <fieldset
      id={`line-${line.line_no}`}
      // Fieldsets default to min-width: min-content, so they refuse to shrink
      // below their widest row and blow past the viewport on phones.
      className={cn(
        'min-w-0 rounded-card border border-border bg-card p-s3 transition-colors',
        line.is_excluded && 'bg-muted opacity-60'
      )}
    >
      <legend className="flex flex-wrap items-center gap-s2 px-s1">
        <span className="text-base font-bold text-muted-foreground">Line {line.line_no}</span>
        <span className="text-base font-bold text-foreground">{lineTitle(line)}</span>
        {line.match_source === 'auto' && <Badge tone="processing">Auto-matched</Badge>}
        {line.match_source === 'created' && <Badge tone="ok">New catalogue entry</Badge>}
        {line.is_excluded && <Badge tone="neutral">Excluded from import</Badge>}
      </legend>

      {/* The printed line, kept verbatim. */}
      {line.raw_description && (
        <p className="mb-s2 px-s1 font-mono text-base text-muted-foreground">
          Printed: {line.raw_description}
        </p>
      )}

      {/* ── Line summary: the seven facts a reviewer checks at a glance ───── */}
      <dl className="mb-s3 grid grid-cols-2 gap-x-s3 gap-y-s2 rounded-control border border-border bg-card px-s3 py-s2 sm:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-base text-muted-foreground">Batch number</dt>
          <dd className="truncate font-mono font-bold text-foreground">{line.batch_no || '—'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-base text-muted-foreground">Medicine name</dt>
          {/* Wraps instead of truncating: this is the value being verified
              against the document, so hiding part of it behind an ellipsis
              defeats the card's purpose. */}
          <dd className="break-words font-bold text-foreground" title={line.medicines?.name || line.raw_description}>
            {line.medicines?.name || line.raw_description || '—'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-base text-muted-foreground">Manufacturer</dt>
          <dd className="truncate text-foreground">{line.medicines?.manufacturer || '—'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-base text-muted-foreground">Quantity</dt>
          <dd className="font-bold tabular text-foreground">{formatQty(units, unit)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-base text-muted-foreground">Purchase rate</dt>
          <dd className="tabular text-foreground"><Money value={line.unit_cost} /></dd>
        </div>
        <div className="min-w-0">
          <dt className="text-base text-muted-foreground">MRP</dt>
          <dd className="tabular text-foreground"><Money value={line.mrp} /></dd>
        </div>
        <div className="min-w-0">
          <dt className="text-base text-muted-foreground">Expiry date</dt>
          <dd className={cn('tabular text-foreground', line.exp_date && line.exp_date < isoToday() && 'text-destructive')}>
            {line.exp_date || '—'}
          </dd>
        </div>
      </dl>

      {warnings.length > 0 && (
        <ul className="mb-s3 flex flex-wrap gap-s1 px-s1">
          {warnings.map((w, i) => (
            <li key={`${w.code}-${i}`}><ValidationBadge warning={w} /></li>
          ))}
        </ul>
      )}

      {/* ── Catalogue mapping ─────────────────────────────────────────────── */}
      <div className="mb-s3 flex flex-wrap items-center justify-between gap-s2 rounded-control border border-border bg-card px-s3 py-s2">
        <span className="min-w-0">
          <span className="block text-base font-bold text-foreground">
            {line.medicines?.name || 'Not linked to the catalogue'}
          </span>
          <span className="block truncate text-base text-muted-foreground">
            {line.medicines
              ? [line.medicines.generic_name, line.medicines.manufacturer].filter(Boolean).join(' · ') || `Sold in ${unit}`
              : 'Nothing can be taken into stock until this line points at a medicine.'}
          </span>
        </span>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-s2">
            <Button variant="secondary" size="compact" onClick={() => onOpenMatch(line)}>
              {line.medicines ? 'Change medicine' : 'Find medicine'}
            </Button>
            {!line.medicines && onOpenQuickAdd && (
              <Button variant="primary" size="compact" onClick={() => onOpenQuickAdd(line)}>
                + Quick add
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Two columns, not three: this card shares the row with the document
          preview, so its container is roughly half the viewport even on wide
          screens — lg:grid-cols-3 keyed off the viewport and squeezed every
          input to ~130px. */}
      <div className="grid gap-s3 sm:grid-cols-2">
        <Field label="Batch number" required error={fieldError(warnings, 'batch_no')}>
          <Input
            value={line.batch_no ?? ''}
            disabled={readOnly}
            onChange={(e) => edit('batch_no')(e.target.value)}
            onBlur={commit('batch_no', (v) => String(v ?? '').trim().toUpperCase())}
            placeholder="PC-9912"
            autoComplete="off"
            className="font-mono"
          />
        </Field>

        <Field
          label="Expiry date"
          required
          hint="month end"
          error={fieldError(warnings, 'exp_date')}
        >
          <Input
            type="date"
            value={line.exp_date ?? ''}
            min={isoToday()}
            disabled={readOnly}
            onChange={(e) => edit('exp_date')(e.target.value)}
            onBlur={commit('exp_date')}
          />
          {fieldNote(warnings, 'exp_date') && (
            <p className="text-base text-warning-ink">{fieldNote(warnings, 'exp_date')}</p>
          )}
        </Field>


        <Field
          label="Billed quantity"
          required
          hint="invoice units"
          error={fieldError(warnings, 'qty_billed')}
        >
          <NumericInput
            integer
            className="text-base"
            value={line.qty_billed ?? ''}
            disabled={readOnly}
            onChange={edit('qty_billed')}
            onBlur={() => onSave(line.id, { qty_billed: toNumber(line.qty_billed) })}
          />
        </Field>

        <Field
          label="Purchase rate"
          required
          hint={`per ${saleUnit}`}
          error={fieldError(warnings, 'unit_cost')}
        >
          <NumericInput
            className="text-base"
            value={line.unit_cost ?? ''}
            disabled={readOnly}
            onChange={edit('unit_cost')}
            onBlur={() => onSave(line.id, { unit_cost: toNumber(line.unit_cost) })}
            placeholder="0.00"
          />
          {fieldNote(warnings, 'unit_cost') && (
            <p className="text-base text-warning-ink">{fieldNote(warnings, 'unit_cost')}</p>
          )}
        </Field>

        <Field
          label="MRP"
          required
          hint={`per ${saleUnit}`}
          error={fieldError(warnings, 'mrp')}
        >
          <NumericInput
            className="text-base"
            value={line.mrp ?? ''}
            disabled={readOnly}
            onChange={edit('mrp')}
            onBlur={() => onSave(line.id, { mrp: toNumber(line.mrp) })}
            placeholder="0.00"
          />
        </Field>

      </div>

      {/* ── The computed figures the reviewer checks against the document ─── */}
      <div className="mt-s3 flex flex-wrap items-baseline justify-between gap-s3 border-t border-border pt-s2">
        <span className="flex flex-wrap items-baseline gap-s3">
          <span className="text-base text-muted-foreground">
            Into stock{' '}
            <span className="font-bold text-foreground">{formatQty(units, unit)}</span>
            {Number(line.qty_free) > 0 && (
              <span> · {formatCount(Number(line.qty_free))} free</span>
            )}
            {/* Contents are shown, never counted — see the Pack column note in
                CLAUDE.md. This is the figure a reviewer checks against the
                carton; the bold one above is what reaches the ledger. */}
            {contents && (
              <span> · {formatCount(contents.quantity)} {contents.unit.toLowerCase()}</span>
            )}
          </span>
          {isOwner && margin !== null && (
            <span className="text-base text-muted-foreground">
              Margin <Money value={margin} className="text-base" tone={margin > 0 ? 'ok' : 'critical'} /> per {saleUnit}
            </span>
          )}
        </span>

        <span className="flex flex-wrap items-baseline gap-s3">
          {line.line_total != null && (
            <span className="text-base text-muted-foreground">
              Printed <Money value={line.line_total} className="text-base" />
            </span>
          )}
          <span className="text-base text-muted-foreground">Line value</span>
          <Money value={value} />
        </span>
      </div>

      {!readOnly && (
        <div className="mt-s2 flex justify-end">
          <Button
            variant="ghost"
            size="compact"
            onClick={() => onToggleExclude(line)}
          >
            {line.is_excluded ? 'Include this line again' : 'Exclude this line'}
          </Button>
        </div>
      )}
    </fieldset>
  );
}
