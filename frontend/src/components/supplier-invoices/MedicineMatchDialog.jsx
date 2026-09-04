import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogClose } from '../../ui/Dialog';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Field from '../../ui/Field';
import { SkeletonRegion, SkeletonRows } from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';
import { Money } from '../../domain/Money';
import { formatPackContent, resolveDispensingUnit } from '../../domain/invoice';

/* ═══════════════════════════════════════════════════════════════════════════
   MedicineMatchDialog — resolving one printed line to one catalogue medicine.

   Search is the trigram endpoint, not the full-text one used at the counter.
   That difference is the point: a distributor prints "PARACIP 500 TAB 10X10"
   where the catalogue holds "Paracip 500mg", and full-text search on those two
   strings finds nothing. Trigram similarity finds it.

   Results are BUTTONS in a list, not a custom listbox. A dialog whose content
   is a stack of buttons is keyboard-operable by construction — Tab reaches
   every option, Enter picks it, Escape leaves — with no aria-activedescendant
   to keep in step and no arrow-key handler to get wrong. The combobox pattern
   earns its complexity at the POS, where the field is used a hundred times a
   day; here it is used once per unmatched line.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function MedicineMatchDialog({
  open,
  onOpenChange,
  line,
  onPick,
  onQuickAdd,
  canQuickAdd,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounce = useRef(null);

  // Seeded from the printed description: the search that is almost always
  // wanted is already run by the time the dialog is open.
  useEffect(() => {
    if (!open) return;
    setQuery(line?.raw_description || '');
    setResults(line?.match_candidates || []);
    setSearched(false);
  }, [open, line]);

  useEffect(() => {
    if (!open) return undefined;
    const term = query.trim();
    if (term.length < 2) { setResults([]); setSearched(false); return undefined; }

    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      setLoading(true);
      api.get(`/supplier-invoices/match/medicines?q=${encodeURIComponent(term)}`)
        .then((res) => { setResults(res.data.medicines || []); setSearched(true); })
        .catch(() => { setResults([]); setSearched(true); })
        .finally(() => setLoading(false));
    }, 300);

    return () => clearTimeout(debounce.current);
  }, [query, open]);

  const dispensing = resolveDispensingUnit(line);
  const packContentDesc = formatPackContent(line);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide">
        <DialogHeader
          title="Link this line to a medicine"
          description={
            line?.raw_description
              ? `The invoice prints “${line.raw_description}”. Pick the catalogue entry it refers to or add a new one.`
              : 'Pick the catalogue entry this line refers to.'
          }
        />
        <DialogBody>
          <div className="flex flex-col gap-s4">
            {line && (
              <div className="rounded-card border border-border bg-muted/30 p-s3 text-base">
                <div className="grid grid-cols-1 gap-x-s3 gap-y-s1 sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">Printed: </span>
                    <span className="font-mono font-medium text-foreground break-words">{line.raw_description || '—'}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Pack on invoice: </span>
                    <span className="font-mono font-medium text-foreground">{line.pack_raw || 'Not printed'}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Dispensing unit: </span>
                    <span className="font-medium text-foreground">{dispensing.label}</span>{' '}
                    {dispensing.isExplicit ? (
                      <span className="text-xs text-muted-foreground">(extracted)</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">(inferred from invoice/product)</span>
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Pack contents: </span>
                    <span className="font-medium text-foreground">{packContentDesc || 'Not detected'}</span>
                  </div>
                </div>
              </div>
            )}

            <Field
              label="Search the catalogue"
              hint="by brand or generic name"
            >
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                loading={loading}
                autoComplete="off"
                placeholder="Paracip, paracetamol…"
              />
            </Field>

            {results.length > 0 && (
              <ul className="flex flex-col gap-s2">
                {results.map((medicine) => (
                  <li key={medicine.id}>
                    <button
                      type="button"
                      onClick={() => { onPick(medicine); onOpenChange(false); }}
                      className={cn(
                        'flex min-h-target w-full items-center justify-between gap-s3 rounded-control',
                        'border border-border bg-card px-s3 py-s2 text-left',
                        'transition-colors duration-instant hover:bg-muted'
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-base font-bold text-foreground">{medicine.name}</span>
                        <span className="block truncate text-base text-muted-foreground">
                          {[medicine.generic_name, medicine.manufacturer].filter(Boolean).join(' · ') || 'No generic name recorded'}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <Money value={medicine.default_selling_price} className="block" />
                        <span className="block text-base text-muted-foreground">per {String(medicine.unit || 'unit').replace(/s$/, '')}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* The input carries its own spinner while it searches; this is
                the result list holding its place, so the first match does not
                shove the dialog's footer down as it arrives. */}
            {loading && results.length === 0 && (
              <SkeletonRegion label="Searching the catalogue…">
                <SkeletonRows count={3} />
              </SkeletonRegion>
            )}

            {!loading && searched && results.length === 0 && (
              <EmptyState
                title="Nothing in the catalogue is close to that"
                body={
                  canQuickAdd
                    ? 'Distributors abbreviate names heavily — try the generic name or a shorter fragment. If this medicine genuinely is not on file yet, add it to the catalogue.'
                    : 'Distributors abbreviate names heavily — try the generic name or a shorter fragment. If this medicine genuinely is not on file yet, leave the line unmapped and the owner will add it before importing.'
                }
                action={
                  canQuickAdd ? (
                    <Button
                      variant="primary"
                      onClick={() => { onOpenChange(false); onQuickAdd(); }}
                    >
                      Add to catalogue
                    </Button>
                  ) : undefined
                }
              />
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          {results.length > 0 && (
            <Button
              variant="secondary"
              onClick={() => { onOpenChange(false); onQuickAdd(); }}
              blockedReason={
                canQuickAdd
                  ? null
                  : 'Only the owner can add a medicine to the catalogue. Leave the line unmapped — the owner resolves it before importing.'
              }
            >
              None of these — add a new medicine
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

