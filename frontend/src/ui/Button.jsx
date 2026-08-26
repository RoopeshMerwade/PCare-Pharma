import { forwardRef, useId, useState } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from '../lib/cn';
import Spinner from './Spinner';

/* ═══════════════════════════════════════════════════════════════════════════
   Button — §3.1, the highest-density component in the app and therefore the
   one carrying the most defect surface. All seven states are defined here so
   that no caller has to reason about them.

   Three rules worth knowing before changing anything:

   1. primary uses a DARK label. White on surface.strong is 1.96:1; the mint
      is a light accent and can only ever carry dark text (7.52:1).

   2. A blocked action stays ENABLED and explains itself (§3.1 "Error" state,
      §6 "must not disable a primary action without surfacing the reason").
      Pass `blockedReason` instead of `disabled` whenever the block is
      something the user could act on — a silently greyed-out button is a
      dead end, and this is the single most common way that rule gets broken.

   3. FLAT FILLS, NO SHELF. Buttons are flat: a 1px border all round and
      nothing underneath. There was previously a 4px bottom border in each
      variant's -active shade (a "shelf") that the button compressed into on
      press; it was removed by request, along with the press translate that
      only made sense paired with it.

      Two things that shelf was carrying had to be re-homed rather than lost:

        · `blockedReason` must stay visible AT REST. That is the state's
          whole point — before it, a blocked "Complete Sale" was pixel-
          identical to a ready one and the only way to discover the block was
          to fail at it. It is now the FULL border that turns warning amber,
          not just the bottom edge, so rule 2 still holds without a shelf.

        · Press feedback is now colour alone (`active:bg-*-active`). Nothing
          moves, so nothing in a button row can reflow on click.

      Padding is symmetric again (`py`, not the old pt-one-step-above-pb),
      because there is no longer an out-of-padding-box edge to compensate
      for. Each size keeps the height it had: 12+20+12 lands default on the
      same 44px the old 12+20+8+4 did, so A6 stays structural rather than
      propped up by min-h-target.
   ═══════════════════════════════════════════════════════════════════════════ */

const buttonVariants = cva(
  // Base: relative for the loading overlay, min-h-target for A6 (44px hit area
  // even when the visual button is shorter), and a transition pinned to the
  // one specified duration. Only colour travels — the press moves nothing.
  [
    'relative inline-flex items-center justify-center gap-s1',
    // A label must never wrap. Without this, a button used as a flex item has
    // a min-content width of its LONGEST WORD, so a neighbouring w-full input
    // squeezes it until the label breaks — "Find bill" became two lines and
    // the two-line button then stretched the input's height to match it.
    // nowrap floors the button at its full label width instead, so the input
    // gives up the space rather than the button.
    'min-h-target whitespace-nowrap rounded-pill font-bold text-base',
    'border',
    'transition-colors duration-instant',
    'disabled:cursor-not-allowed disabled:opacity-40',
    // §3.1 disabled must retain 3:1 for non-text UI. At 40% opacity a fill
    // loses contrast against the canvas, so disabled buttons pull their border
    // to the control colour so the boundary survives.
    'disabled:border-input',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: [
          'bg-primary text-primary-foreground',
          'border-transparent',
          'hover:bg-primary-hover active:bg-primary-active',
        ].join(' '),
        secondary: [
          'bg-card text-foreground',
          'border-input',
          'hover:bg-muted active:bg-border',
        ].join(' '),
        destructive: [
          'bg-destructive text-destructive-foreground',
          'border-transparent',
          'hover:bg-destructive-hover active:bg-destructive-active',
        ].join(' '),
        ghost: [
          'bg-transparent text-foreground',
          // Transparent rather than absent: a ghost beside a primary has to
          // agree with it on height, and the border is 1px of that height.
          'border-transparent',
          'hover:bg-muted active:bg-border',
        ].join(' '),
      },
      size: {
        // §3.1 anatomy: space.3 horizontal, and symmetric space.3 vertical now
        // that no shelf needs compensating. 12 + 20 + 12 = 44px, the same
        // height the shelved 12 + 20 + 8 + 4 produced.
        default: 'px-s3 py-s3',
        // Visually tighter for row-level actions; min-h-target still applies,
        // so the hit area stays 44px tall while the fill looks compact.
        compact: 'px-s3 py-s2',
        // Square, for icon-only controls. 44×44 exactly.
        icon: 'w-target px-s2 py-s3 shrink-0',
        // Fills its container — modal footers, the POS submit — but stops at
        // the width of the auth card, because past roughly 26rem a button
        // stops reading as a button and starts reading as a banner. On a
        // 1390px content column an uncapped w-full put a 1390px "Complete
        // sale" across the page. Every narrow caller (AuthLayout's card, the
        // owner's quick-actions rail) is already inside the cap, so w-full
        // still governs there and nothing moves.
        block: 'w-full max-w-[26rem] px-s4 py-s4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  }
);

/* Module scope, not inside Button — a component defined in a component body
   gets a new identity every render (see ui/Field.jsx and the lint rule). */
function AlertGlyph() {
  return (
    <svg
      className="mt-s1 h-4 w-4 shrink-0"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 1.75 15 14.25H1L8 1.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 6.5v3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.75" r="0.9" fill="currentColor" />
    </svg>
  );
}

const Button = forwardRef(function Button(
  {
    className,
    variant,
    size,
    asChild = false,
    loading = false,
    disabled = false,
    blockedReason = null,
    onClick,
    children,
    ...props
  },
  ref
) {
  const reasonId = useId();
  const [showReason, setShowReason] = useState(false);
  const Comp = asChild ? Slot : 'button';

  if (import.meta.env.DEV && asChild && loading) {
    // Slot clones our props onto the single child element and has no room of
    // its own to overlay a spinner — the wrapper `loading` relies on only
    // exists on the native <button> path below. Show the loading state on
    // the child itself instead.
    throw new Error('Button: `loading` has no effect combined with `asChild`.');
  }

  // Loading is a form of disabled, but it is announced rather than merely
  // greyed — A10 requires the busy state to reach the screen reader.
  const isInert = disabled || loading;

  const handleClick = (event) => {
    if (blockedReason) {
      // Surface the reason at the point of failure rather than swallowing the
      // click or firing a toast the user has to go looking for (§3.1).
      event.preventDefault();
      setShowReason(true);
      return;
    }
    setShowReason(false);
    onClick?.(event);
  };

  // Slot (the asChild path) requires EXACTLY ONE valid element as its child,
  // to clone our DOM props onto directly — the consumer's own element (an
  // `<a>`, typically), untouched by wrapping. The native <button> path has no
  // such constraint, so it's the only one that gets the label-wrapping span
  // and the loading-spinner overlay.
  const content = asChild ? children : (
    <>
      {/* The label stays in the DOM while loading so the button cannot
          collapse to spinner width mid-action (§3.1). */}
      <span className={cn('inline-flex items-center gap-s1', loading && 'invisible')}>
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      )}
    </>
  );

  const button = (
    <Comp
      ref={ref}
      className={cn(
        buttonVariants({ variant, size }),
        // The border turns amber the moment the button knows it is blocked —
        // not on click. With the shelf gone this is the whole 1px edge rather
        // than the bottom of it, which is what keeps a blocked primary from
        // being pixel-identical to a ready one (rule 2). twMerge lets this
        // twMerge lets className still beat the variant's border colour.
        className
      )}
      disabled={asChild ? undefined : isInert}
      aria-busy={loading || undefined}
      aria-disabled={asChild && isInert ? true : undefined}
      aria-describedby={showReason ? reasonId : undefined}
      onClick={handleClick}
      {...props}
    >
      {content}
    </Comp>
  );

  if (!blockedReason) return button;

  // Only wrapped when there is a reason to show, so the common case emits a
  // bare <button> and callers' layout classes behave predictably.
  return (
    // The reason is absolutely positioned below the button so its appearance
    // never changes the wrapper's height — in a header row that would lift
    // the button off alignment with its siblings. Width-capped and
    // items-start so the text wraps instead of stretching the button.
    <div className="relative flex w-fit flex-col items-start">
      {button}
      {showReason && (
        <p
          id={reasonId}
          role="alert"
          // Amber, not red. A block is a precondition the user can satisfy —
          // "add a medicine first" — whereas the destructive ramp means loss
          // or failure. Reading them in the same colour taught staff to treat
          // both as errors; the button's border above is already amber, so the
          // message and the control that raised it now match.
          // Anchored to the wrapper's RIGHT edge: this button typically sits
          // at the far right of a header row, so a left-anchored w-max bubble
          // overflows the viewport and creates a horizontal scrollbar.
          // Wider on large screens so the message reads in two or three lines
          // instead of a tall sliver, and given a border + stronger shadow so
          // it reads as a deliberate callout rather than a stray label.
          className="absolute right-0 top-full z-10 mt-s2 flex w-max max-w-[18rem] items-start gap-s2 rounded-control border border-warning/40 bg-warning-wash px-s3 py-s2 text-base text-warning-ink shadow-2 sm:max-w-sm lg:max-w-md"
        >
          <AlertGlyph />
          <span>{blockedReason}</span>
        </p>
      )}
    </div>
  );
});

export default Button;
export { buttonVariants };
