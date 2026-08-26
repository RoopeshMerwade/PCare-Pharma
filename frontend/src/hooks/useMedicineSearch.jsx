import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { controlClasses } from '../ui/Input';
import Spinner from '../ui/Spinner';
import { Money, Qty } from '../domain/Money';
import { stockStatus } from '../domain/stock';

/**
 * useMedicineSearch — debounced catalogue autocomplete.
 * Used by billing and purchase orders.
 */
export function useMedicineSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) { setResults([]); return undefined; }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.get(`/medicines/search?q=${encodeURIComponent(query)}`);
        setResults(res.data.medicines);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const reset = () => { setQuery(''); setResults([]); };

  return { query, setQuery, results, loading, reset };
}

/* ═══════════════════════════════════════════════════════════════════════════
   MedicineSearchInput — the combobox at the top of every sale.

   The previous version committed a selection on `onMouseDown` only, with no
   arrow-key handling and no ARIA roles, so the single most-used control in the
   app could not be driven from a keyboard at all — a straight A5 failure on
   the POS flow, which A5 names explicitly.

   This implements the WAI-ARIA combobox pattern: ArrowUp/ArrowDown move the
   active option, Enter commits it, Escape closes the list, and
   aria-activedescendant keeps a screen reader in step without moving DOM focus
   out of the input.
   ═══════════════════════════════════════════════════════════════════════════ */

export function MedicineSearchInput({ onSelect, placeholder = 'Search medicines…', label = 'Add a medicine' }) {
  const { query, setQuery, results, loading, reset } = useMedicineSearch();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const id = useId();
  const listId = `${id}-listbox`;
  const blurTimer = useRef(null);

  useEffect(() => setActiveIndex(-1), [results]);
  useEffect(() => () => clearTimeout(blurTimer.current), []);

  const commit = (medicine) => {
    onSelect(medicine);
    reset();
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event) => {
    if (!open || results.length === 0) {
      if (event.key === 'ArrowDown' && results.length > 0) { setOpen(true); setActiveIndex(0); event.preventDefault(); }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      commit(results[activeIndex]);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  const showNoMatch = open && query.trim() && !loading && results.length === 0;

  return (
    <div className="relative">
      <label htmlFor={id} className="mb-s1 block text-base font-bold text-foreground">{label}</label>

      <div className="relative">
        <input
          id={id}
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          autoComplete="off"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { if (query) setOpen(true); }}
          // Delayed so a click on an option lands before the list unmounts.
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={cn(controlClasses, loading && 'pr-s6')}
        />
        {loading && (
          <span className="pointer-events-none absolute right-s3 top-1/2 -translate-y-1/2 text-muted-foreground">
            <Spinner />
          </span>
        )}
      </div>

      {open && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching medicines"
          className="absolute left-0 right-0 top-full z-30 mt-s1 max-h-64 overflow-y-auto rounded-card border border-border bg-card shadow-2"
        >
          {results.map((medicine, index) => {
            const status = stockStatus(medicine);
            const isActive = index === activeIndex;
            return (
              <li
                key={medicine.id}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => { e.preventDefault(); commit(medicine); }}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  'flex min-h-target cursor-pointer items-center justify-between gap-s3 border-b border-border px-s3 py-s2 last:border-0',
                  isActive && 'bg-muted'
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-base font-bold text-foreground">{medicine.name}</span>
                  {medicine.generic_name && (
                    <span className="block truncate text-base text-muted-foreground">{medicine.generic_name}</span>
                  )}
                </span>
                <span className="shrink-0 text-right">
                  <Money value={medicine.default_selling_price} className="block" />
                  {status.key === 'out' ? (
                    /* Naming the substitute path here saves the cashier adding
                       the line, reading the banner, then swapping it out.

                       Gated on generic_name because that is the field the
                       /alternatives lookup matches on — with no molecule
                       recorded the endpoint returns [] by construction
                       (medicines.service.js:214), so promising substitutes
                       would be a dead end. This says they will be looked up,
                       not that they exist: confirming that needs a request
                       per row, and a keystroke-rate fan-out across the
                       dropdown is not worth it at the counter. */
                    <span className="block text-base text-destructive">
                      Out of stock
                      {medicine.generic_name && (
                        <span className="text-muted-foreground"> · substitutes checked on add</span>
                      )}
                    </span>
                  ) : (
                    <Qty
                      value={medicine.total_stock}
                      unit={medicine.unit}
                      tone={status.key === 'low' ? 'low' : undefined}
                      className="block text-base font-normal"
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {showNoMatch && (
        <div className="absolute left-0 right-0 top-full z-30 mt-s1 rounded-card border border-border bg-card px-s3 py-s2 text-base text-muted-foreground shadow-2">
          Nothing in the catalogue matches “{query}”. Check the spelling, or search by the generic name.
        </div>
      )}
    </div>
  );
}
