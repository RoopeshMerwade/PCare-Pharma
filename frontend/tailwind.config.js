/* ═══════════════════════════════════════════════════════════════════════════
   Tailwind consumes tokens.css and adds nothing of its own. Every value here
   is `var(--token)` — if a colour or size is not in tokens.css, it cannot be
   expressed as a utility class, which is what makes §6's "no one-off values"
   rule structural rather than a matter of discipline.

   Naming follows Shadcn UI convention (background / foreground / card / muted
   / primary / destructive / border / input / ring), since the guidelines are
   built on that foundation. The mapping back to the spec's own semantic names
   is in the comment beside each entry.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Tailwind needs `rgb(<channels> / <alpha-value>)` to support `bg-primary/40`. */
const token = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    /* ── Type scale — OVERRIDDEN, not extended ────────────────────────────
       §2.1 sets 14px as the floor for data-dense surfaces. Removing the
       default scale means `text-xs` (12px) and everything below it no longer
       exist as classes, so the floor cannot be breached by accident.
       `xs` is kept as an alias because the spec lists it — at the same 14px. */
    fontSize: {
      xs:   ['var(--font-size-base)', { lineHeight: 'var(--line-height-base)' }],
      base: ['var(--font-size-base)', { lineHeight: 'var(--line-height-base)' }],
      sm:   ['var(--font-size-sm)',   { lineHeight: 'var(--line-height-sm)' }],
      md:   ['var(--font-size-md)',   { lineHeight: 'var(--line-height-md)' }],
      lg:   ['var(--font-size-lg)',   { lineHeight: 'var(--line-height-lg)' }],
    },

    /* Only two weights are specified; anything else would be a one-off. */
    fontWeight: {
      normal: 'var(--font-weight-base)',
      bold:   'var(--font-weight-bold)',
    },

    extend: {
      colors: {
        background:   token('--color-surface-base'),    /* surface.base  [EXT: #000000 ruled artifact] */
        foreground:   token('--color-text-primary'),    /* text.primary   */

        card:         token('--color-surface-muted'),   /* surface.muted  */
        muted:        token('--color-surface-raised'),  /* surface.raised — disabled fill, selected row */
        'muted-foreground': token('--color-text-tertiary'), /* text.tertiary */

        /* The dark-label ruling lives here: primary-foreground is dark text on mint.
           Mint is a light accent fill (L=0.551); white text on mint is 1.96:1.
           --color-primary-foreground is 7.52:1 (light) / 7.75:1 (dark). */
        primary:              token('--color-surface-strong'),
        'primary-foreground': token('--color-primary-foreground'),
        'primary-hover':      token('--color-surface-strong-hover'),
        'primary-active':     token('--color-surface-strong-active'),

        /* Mint at text weight on a light ground. Links, icon strokes, marks. */
        accent:       token('--color-accent-deep'),

        border:       token('--color-border-default'),  /* decorative rules — 1.4.11 does not apply */
        'border-strong': token('--color-border-muted'),
        input:        token('--color-border-control'),  /* controls — 1.4.11 DOES apply, 3.12:1 */
        ring:         token('--color-focus-ring'),

        destructive:              token('--color-status-critical'),
        'destructive-foreground': token('--color-destructive-foreground'),
        'destructive-hover':      token('--color-status-critical-hover'),
        'destructive-active':     token('--color-status-critical-active'),
        'destructive-ink':        token('--color-status-critical-ink'),
        'destructive-wash':       token('--color-status-critical-wash'),

        warning:            token('--color-status-low'),
        'warning-ink':      token('--color-status-low-ink'),
        'warning-wash':     token('--color-status-low-wash'),

        success:            token('--color-status-ok'),
        'success-wash':     token('--color-status-ok-wash'),

        /* Solid badge palette — saturated ground, white label, brighter
           same-hue edge. The `-edge` suffix is deliberate rather than nesting
           `{ bg, border }`, which would produce `bg-badge-success-bg` — a
           stutter at every call site. The bare name IS the ground, because
           that is the token a badge reaches for first. */
        badge: {
          fg:                token('--color-badge-foreground'),
          success:           token('--color-badge-success-bg'),
          'success-edge':    token('--color-badge-success-border'),
          processing:        token('--color-badge-processing-bg'),
          'processing-edge': token('--color-badge-processing-border'),
          critical:          token('--color-badge-critical-bg'),
          'critical-edge':   token('--color-badge-critical-border'),
          warning:           token('--color-badge-warning-bg'),
          'warning-edge':    token('--color-badge-warning-border'),
          info:              token('--color-badge-info-bg'),
          'info-edge':       token('--color-badge-info-border'),
          neutral:           token('--color-badge-neutral-bg'),
          'neutral-edge':    token('--color-badge-neutral-border'),
          flag:              token('--color-badge-flag-bg'),
          'flag-edge':       token('--color-badge-flag-border'),
        },

        /* Chart series + chrome. The slot ORDER is the CVD-safety mechanism
           (validated in both modes against the card surface — see tokens.css)
           and colour follows the entity, never its rank: cash=1, upi=2,
           credit=3, card=4, fixed in domain/charts/series.js. */
        chart: {
          1: token('--color-chart-1'),
          2: token('--color-chart-2'),
          3: token('--color-chart-3'),
          4: token('--color-chart-4'),
          5: token('--color-chart-5'),
          6: token('--color-chart-6'),
          7: token('--color-chart-7'),
          8: token('--color-chart-8'),
          grid: token('--color-chart-grid'),
          axis: token('--color-chart-axis'),
        },
      },

      fontFamily: {
        sans: ['PT Sans', 'PT Sans Fallback', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'Cascadia Code', 'SF Mono', 'Consolas', 'monospace'],
      },

      /* §2.3. Named `s1…s7` rather than 1…7 so they never blur into Tailwind's
         numeric scale — `p-s5` is unambiguously the token, `p-5` is not. */
      spacing: {
        s1: 'var(--space-1)',  s2: 'var(--space-2)',  s3: 'var(--space-3)',
        s4: 'var(--space-4)',  s5: 'var(--space-5)',  s6: 'var(--space-6)',
        s7: 'var(--space-7)',  /* PAGE LEVEL ONLY — see §2.3 and the lint rule */
        target: 'var(--target-min)',   /* 44px — A6 */
        bottombar: 'var(--bottom-bar-clearance)', /* clears the mobile bottom nav */
      },

      /* §2.4. Named by role, not by t-shirt size, so `rounded-sm` (2px in stock
         Tailwind) can never be mistaken for radius.sm (28px). */
      borderRadius: {
        control: 'var(--radius-control)', /* [EXT] inputs, selects, cells */
        pill:    'var(--radius-xs)',      /* radius.xs — buttons, badges */
        card:    'var(--radius-sm)',      /* radius.sm — cards, modals */
      },

      boxShadow: {
        1: 'var(--shadow-1)',   /* resting cards and rows */
        2: 'var(--shadow-2)',   /* anything above the base plane */
      },

      transitionDuration: {
        instant: 'var(--duration-instant)',
      },

      minHeight: { target: 'var(--target-min)' },
      minWidth:  { target: 'var(--target-min)' },

      keyframes: {
        'fade-in':  { from: { opacity: '0' }, to: { opacity: '1' } },
        'fade-out': { from: { opacity: '1' }, to: { opacity: '0' } },
        // DialogContent centers itself with left-1/2 top-1/2 plus a static
        // -translate-x/y-1/2 utility class — a transform of its own. Since a
        // CSS animation's `transform` keyframes replace the element's whole
        // transform for the animation's duration, a keyframe with just
        // `scale(...)` drops that translate for 150ms: the dialog renders
        // with its top-left corner at viewport center instead of its actual
        // center, then snaps into place the instant the animation ends and
        // the static classes take back over. Both parts belong in every frame.
        'zoom-in':  { from: { opacity: '0', transform: 'translate(-50%, -50%) scale(0.97)' }, to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'slide-in-left':  { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
      },
      animation: {
        'fade-in':  'fade-in var(--duration-instant) ease-out',
        'fade-out': 'fade-out var(--duration-instant) ease-in',
        'zoom-in':  'zoom-in var(--duration-instant) ease-out',
        'slide-in-right': 'slide-in-right var(--duration-instant) ease-out',
        'slide-in-left':  'slide-in-left var(--duration-instant) ease-out',
      },
    },
  },
  plugins: [],
};
