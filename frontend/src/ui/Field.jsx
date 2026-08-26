import { createContext, useContext, useId } from 'react';
import { cn } from '../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   Field — the label / control / message wrapper every form uses.

   THIS COMPONENT LIVES AT MODULE SCOPE AND MUST STAY THERE.

   CLAUDE.md records this as a recurring defect class: three separate modals
   (MedicineModal, SuppliersPage, BatchDrawer) each defined their own `Field`
   *inside* the parent component. That gives the wrapper a new identity on
   every parent render, so React unmounts and remounts the subtree and the
   <input> loses focus after a single keystroke — the "form only accepts one
   character" bug. Shipping one shared Field removes the opportunity to
   reintroduce it. There is a regression test for exactly this in Field.test.jsx.

   Field owns the id wiring so no caller has to think about aria-describedby
   (A7): the control gets its label, its hint and its error connected
   automatically through context.
   ═══════════════════════════════════════════════════════════════════════════ */

const FieldContext = createContext(null);

/** Controls call this to pick up the ids and invalid state Field computed. */
export function useFieldControl() {
  return useContext(FieldContext) || {};
}

export default function Field({
  label,
  required = false,
  hint,
  error,
  children,
  className,
  ...props
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Error wins over hint as the description — a screen reader reading both
  // buries the actionable half under the advisory one.
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>
      {/* `relative` is load-bearing: the sr-only "(required)" span below — and
          the label itself under the `[&>label]:sr-only` pattern — is
          position:absolute. Without a positioned ancestor its containing block
          is the <body>, so no scroll container between here and there can clip
          it, and its layout position stretches the page's scrollable area —
          hundreds of px of phantom scroll on long forms. */}
      <div className={cn('relative flex flex-col gap-s1', className)} {...props}>
        {/* §3.5: the label is always visible. A placeholder is not a label —
            it vanishes the moment the field has content, which is exactly
            when a distracted user needs it. */}
        <label htmlFor={id} className="text-base font-bold text-foreground">
          {label}
          {required && (
            <span className="text-destructive" aria-hidden="true">
              {' *'}
            </span>
          )}
          {required && <span className="sr-only"> (required)</span>}
          {hint && (
            <span id={hintId} className="ml-s1 font-normal text-muted-foreground">
              {hint}
            </span>
          )}
        </label>

        {children}

        {/* §3.5: the error says what is wrong AND how to fix it. role="alert"
            so it is announced when it appears, not only when focus lands. */}
        {error && (
          <p id={errorId} role="alert" className="text-base text-destructive">
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}
