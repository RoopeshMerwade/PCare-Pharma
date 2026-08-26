import { cva } from 'class-variance-authority';
import { cn } from '../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   Badge — the carrier for every status in the app.

   ── A4 / §6 compliance ──────────────────────────────────────────────────
   Status is never conveyed by colour alone: `children` is the status text
   and the API offers no way to render a bare dot. THAT is the compliance
   mechanism. The previous header claimed each tone was separable in
   grayscale by fill lightness; with the shipped --color-badge-* palette
   that is no longer true (flag 0.142 / info 0.146 / low 0.153 / ok 0.160
   relative luminance — a 0.018 band, indistinguishable desaturated). Any
   A4 assertion must key on the LABEL, not on pixel lightness — which is
   what domain/stock.test.js and Badge.test.jsx both do.
   For tones needing a second non-colour channel, pass `icon`.

   ── Two variants, deliberately ──────────────────────────────────────────
   wash   (default) — the tint + ink treatment (status-*-wash / status-*-ink).
                      Default because roughly half this app's badges sit in
                      dense surfaces — invoice lines, batch cards, dashboard
                      alert rows, stock tables — where a pill shares a row
                      with the figures it must not shout over.
   solid            — --color-badge-* grounds + white label + brighter
                      same-hue edge. Opt in for status columns: workflow
                      state that should be readable across a table at a
                      glance. --color-badge-* is byte-identical in light and
                      dark mode, so on the white card these fills are far
                      heavier than a wash. That weight is the point in a
                      status column and a liability everywhere else.

   Tone names stay semantic — `tone="critical"`, never `tone="red"`.

   ── Contrast, measured (solid variant, white label) ─────────────────────
   processing 7.02:1 · critical 5.84:1 · success 5.61:1 · flag 5.25:1
   info 5.12:1 · neutral 4.96:1 · low 4.88:1        all ✓ A1 (AA normal)

   Type stays at --font-size-base (14px). It is the documented floor for
   data-dense surfaces, so there is no smaller step to take; weight stays at
   --font-weight-bold, the only non-400 the scale defines, and it is what
   holds a 14px white label legible on a saturated ground.

   No `capitalize` here on purpose: labels are authored once in
   domain/StatusBadge.jsx and §5 requires a status be called the same thing
   at every step of a flow. Title-casing them in CSS would make the registry
   stop being the place that decides what a status is called.
   ═══════════════════════════════════════════════════════════════════════════ */

const badgeVariants = cva(
  [
    'inline-flex items-center gap-s1 whitespace-nowrap',
    'rounded-pill px-s3 py-s1',
    'text-base font-bold',
    'border',
  ].join(' '),
  {
    variants: {
      variant: {
        solid: 'text-badge-fg',
        wash: '',
      },
      tone: {
        ok: '',
        success: '',
        low: '',
        warning: '',
        critical: '',
        error: '',
        processing: '',
        info: '',
        neutral: '',
        flag: '',
      },
    },

    compoundVariants: [
      /* ── solid ─────────────────────────────────────────────────────────
         Fill carries the tone, the edge is the same hue driven brighter so
         the pill keeps an outline on both the dark canvas and the white
         card. Label is --color-badge-foreground in every case.            */
      { variant: 'solid', tone: 'ok', class: 'bg-badge-success border-badge-success-edge' },
      { variant: 'solid', tone: 'success', class: 'bg-badge-success border-badge-success-edge' },

      { variant: 'solid', tone: 'low', class: 'bg-badge-warning border-badge-warning-edge' },
      { variant: 'solid', tone: 'warning', class: 'bg-badge-warning border-badge-warning-edge' },

      { variant: 'solid', tone: 'critical', class: 'bg-badge-critical border-badge-critical-edge' },
      { variant: 'solid', tone: 'error', class: 'bg-badge-critical border-badge-critical-edge' },

      { variant: 'solid', tone: 'processing', class: 'bg-badge-processing border-badge-processing-edge' },
      { variant: 'solid', tone: 'info', class: 'bg-badge-info border-badge-info-edge' },

      { variant: 'solid', tone: 'neutral', class: 'bg-badge-neutral border-badge-neutral-edge' },
      { variant: 'solid', tone: 'flag', class: 'bg-badge-flag border-badge-flag-edge' },

      /* ── wash ──────────────────────────────────────────────────────────
         Unchanged from the previous implementation. The -ink tokens exist
         because plain -low / -critical do not clear 4.5:1 on their own
         wash; do not "simplify" these to the non-ink token.               */
      { variant: 'wash', tone: 'ok', class: 'bg-success-wash text-success border-success/30' },
      { variant: 'wash', tone: 'success', class: 'bg-success-wash text-success border-success/30' },

      { variant: 'wash', tone: 'low', class: 'bg-warning-wash text-warning-ink border-warning/30' },
      { variant: 'wash', tone: 'warning', class: 'bg-warning-wash text-warning-ink border-warning/30' },

      { variant: 'wash', tone: 'critical', class: 'bg-destructive-wash text-destructive-ink border-destructive/30' },
      { variant: 'wash', tone: 'error', class: 'bg-destructive-wash text-destructive-ink border-destructive/30' },

      { variant: 'wash', tone: 'processing', class: 'bg-accent/10 text-accent border-accent/30' },
      { variant: 'wash', tone: 'info', class: 'bg-accent/10 text-accent border-accent/30' },

      { variant: 'wash', tone: 'neutral', class: 'bg-muted text-muted-foreground border-border-strong' },
      { variant: 'wash', tone: 'flag', class: 'bg-card text-accent border-accent' },
    ],

    defaultVariants: { variant: 'wash', tone: 'neutral' },
  }
);

export default function Badge({ variant, tone, className, icon, children, ...props }) {
  return (
    <span
      data-tone={tone ?? 'neutral'}
      data-variant={variant ?? 'wash'}
      className={cn(badgeVariants({ variant, tone }), className)}
      {...props}
    >
      {icon && (
        <span aria-hidden="true" className="leading-none">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}

export { badgeVariants };
