import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { useFieldControl } from './Field';
import { controlClasses } from './Input';

/* ═══════════════════════════════════════════════════════════════════════════
   Select — a native <select>, deliberately.

   Radix Select is in the dependency set and is used where a listbox needs
   custom rows. A plain form select is not that case: the native control gives
   the counter tablet its own OS picker, works without JavaScript-driven
   positioning, and cannot desync its focus ring from the field it belongs to.
   Choosing it here is about reliability at the counter, not about saving code.

   The chevron is drawn as a background image so the control stays a single
   focusable element — wrapping it in a div with an overlaid icon is where the
   click target and the focus ring usually drift apart.
   ═══════════════════════════════════════════════════════════════════════════ */

// Encoded inline: a data URI cannot read a CSS variable, so the stroke colour
// is the one place a literal is unavoidable. It is --color-text-tertiary.
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23465951' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

const Select = forwardRef(function Select(
  { className, invalid, id, children, placeholder, 'aria-describedby': describedByProp, ...props },
  ref
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field.invalid;

  return (
    <select
      ref={ref}
      id={id || field.id}
      aria-describedby={describedByProp || field.describedBy}
      aria-invalid={isInvalid || undefined}
      className={cn(
        controlClasses,
        'cursor-pointer appearance-none pr-s6',
        isInvalid && 'border-destructive hover:border-destructive focus-visible:border-destructive',
        className
      )}
      style={{
        backgroundImage: CHEVRON,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 0.75rem center',
      }}
      {...props}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {children}
    </select>
  );
});

export default Select;
