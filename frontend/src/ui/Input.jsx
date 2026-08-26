import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { useFieldControl } from './Field';
import Spinner from './Spinner';

/* ═══════════════════════════════════════════════════════════════════════════
   Input, NumericInput, Textarea — §3.5.

   Low density (2 instances by the spec's count) but the highest consequence in
   the app: these are the POS quantity and price fields.

   Focus does NOT rely on the ring alone. §3.5 calls that out specifically —
   a 2px ring can read thin against a raised modal surface — so focus also
   changes the border colour.
   ═══════════════════════════════════════════════════════════════════════════ */

export const controlClasses = [
  'w-full min-h-target rounded-control bg-card px-s3 py-s2',
  'text-base text-foreground placeholder:text-muted-foreground',
  'border border-input',
  'transition-colors duration-instant',
  // Hover: border shifts to the heavier weight (§3.5).
  'hover:border-muted-foreground',
  // Focus: ring AND border change, per the note above.
  'focus-visible:border-ring',
  // Disabled: raised fill + tertiary text (§3.5).
  'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
].join(' ');

const invalidClasses = 'border-destructive hover:border-destructive focus-visible:border-destructive';

const Input = forwardRef(function Input(
  { className, loading = false, invalid, id, suffix, 'aria-describedby': describedByProp, ...props },
  ref
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field.invalid;

  const input = (
    <input
      ref={ref}
      id={id || field.id}
      aria-describedby={describedByProp || field.describedBy}
      aria-invalid={isInvalid || undefined}
      className={cn(
        controlClasses,
        isInvalid && invalidClasses,
        loading && 'pr-s6',
        // The border itself moves to the wrapper below, not just to the right
        // edge — an input keeping its own top/left/bottom border stacked
        // against the wrapper's was the bug: two separate border boxes in the
        // same color usually look fine, but the instant either one changes on
        // focus/hover/invalid and the other doesn't, the seam visibly splits
        // into two mismatched lines. One box, one border, no seam.
        suffix && 'rounded-l-control rounded-r-none border-0',
        className
      )}
      {...props}
    />
  );

  /* A trailing control that belongs to the field — "Show" on a password, a
     unit label, a lookup button. Laid out as a flex row rather than by padding
     the input to clear an absolutely-positioned overlay, so the control can be
     any width and the hit area never overlaps the text.

     The wrapper is the ONLY element that owns a border, and `overflow-hidden`
     crops everything inside to its own rounded-control curve — without it the
     suffix cell's square corners peek past the border's curve at top-right and
     bottom-right, which is what "the corners don't line up" actually is. The
     divider before the suffix tracks the wrapper's state via `group-*`
     variants instead of keeping its own static colour, so hover/focus/invalid
     recolour the whole shape at once rather than just the input's three sides. */
  if (suffix) {
    return (
      <div
        className={cn(
          'group flex items-stretch overflow-hidden rounded-control border border-input bg-card',
          'transition-colors duration-instant hover:border-muted-foreground focus-within:border-ring',
          isInvalid && 'border-destructive hover:border-destructive focus-within:border-destructive'
        )}
      >
        {input}
        <div
          className={cn(
            // pr-s2, not s1 — the Show button's own focus-visible outline
            // (2px + 2px offset = 4px) needs clearance inside the clipped
            // wrapper, or overflow-hidden crops the outline along with the
            // square corners it's there to remove.
            'flex items-center border-l border-input bg-card pr-s2',
            'transition-colors duration-instant group-hover:border-muted-foreground group-focus-within:border-ring',
            isInvalid && 'border-destructive group-hover:border-destructive group-focus-within:border-destructive'
          )}
        >
          {suffix}
        </div>
      </div>
    );
  }

  // §3.5: async-validated fields (an employee id uniqueness check) show a
  // trailing spinner inside the field rather than shifting the layout.
  if (!loading) return input;
  return (
    <div className="relative">
      {input}
      <span className="pointer-events-none absolute right-s3 top-1/2 -translate-y-1/2 text-muted-foreground">
        <Spinner />
      </span>
    </div>
  );
});

/* ───────────────────────────────────────────────────────────────────────────
   NumericInput — the pharmacy-specific MUST in §3.5.

   Two rules, both about not lying to the person at the counter:

   · Non-numeric characters are rejected at the keystroke, not at submit.
   · The value is NEVER silently clamped. If someone types 40 when 12 are in
     stock, the 40 stays on screen and the caller reports "Only 12 strips in
     stock" — clamping to 12 without saying so is how a sale gets rung up
     wrong and nobody notices.

   It therefore has no `max` prop by design. Bounds are the caller's to
   validate and to explain.
   ─────────────────────────────────────────────────────────────────────────── */

const NUMERIC = /^\d*$/;
const DECIMAL = /^\d*\.?\d{0,2}$/;

export const NumericInput = forwardRef(function NumericInput(
  { value, onChange, integer = false, className, ...props },
  ref
) {
  const pattern = integer ? NUMERIC : DECIMAL;

  const handleChange = (event) => {
    const next = event.target.value;
    // Empty is always allowed — otherwise the field can never be cleared and
    // corrected, which is worse than a transiently invalid value.
    if (next === '' || pattern.test(next)) onChange?.(next, event);
  };

  return (
    <Input
      ref={ref}
      type="text"
      // "numeric" gives tablets the digit pad; "decimal" adds the separator.
      inputMode={integer ? 'numeric' : 'decimal'}
      autoComplete="off"
      value={value ?? ''}
      onChange={handleChange}
      className={cn('tabular text-sm', className)}
      {...props}
    />
  );
});

export const Textarea = forwardRef(function Textarea(
  { className, invalid, id, rows = 3, 'aria-describedby': describedByProp, ...props },
  ref
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field.invalid;

  return (
    <textarea
      ref={ref}
      id={id || field.id}
      rows={rows}
      aria-describedby={describedByProp || field.describedBy}
      aria-invalid={isInvalid || undefined}
      className={cn(controlClasses, 'resize-y', isInvalid && invalidClasses, className)}
      {...props}
    />
  );
});

export default Input;
