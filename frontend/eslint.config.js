import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

/* ═══════════════════════════════════════════════════════════════════════════
   Guardrails.

   The state this redesign replaced is what happens when consistency is a
   matter of discipline: two colour palettes, sixteen hand-rolled modals, and
   the same focus bug fixed three times. These rules make the same drift a CI
   failure rather than a code-review conversation.

   Every rule below corresponds to a specific line in the guidelines, cited in
   its message so the fix is obvious from the error alone.
   ═══════════════════════════════════════════════════════════════════════════ */

// Stock Tailwind palettes plus the retired navy/cream/brand/coral scale.
const BANNED_PALETTE = String.raw`\b(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|navy|cream|brand|coral)-(50|100|200|300|400|500|600|700|800|900|950)\b`;

/* §6 bans one-off values on the SCALES the spec defines — spacing, type,
   radius, shadow, colour. It does not ban arbitrary structural dimensions:
   `max-w-[26rem]` on a toast or `w-[min(17rem,85vw)]` on a drawer is layout,
   not a scale violation, and forcing those through the spacing scale would be
   the tail wagging the dog. So the rules below are deliberately targeted at
   the utilities that map to a token scale. */
const ARBITRARY_SPACING = String.raw`(^|\s)(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\[[^\]]+\]`;
const ARBITRARY_TYPE = String.raw`(^|\s)(text|leading|font)-\[[^\]]+\]`;
const ARBITRARY_SHAPE = String.raw`(^|\s)(rounded|rounded-[a-z]+|shadow|duration)-\[[^\]]+\]`;
const ARBITRARY_COLOR = String.raw`(^|\s)(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|accent)-\[[^\]]*#`;

const RAW_COLOR = String.raw`#[0-9A-Fa-f]{6}\b|\brgb\(|\blab\(|\boklab\(|\bhsl\(`;

export default [
  { ignores: ['dist/**', 'node_modules/**'] },

  js.configs.recommended,

  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      /* react-hooks v7 ships the React Compiler rule set. `set-state-in-effect`
         fires on the fetch-on-mount pattern every list page in this app uses
         (`setLoading(true)` inside an effect), which is correct code, not a
         defect — so it is a warning worth reading rather than a CI failure.
         The rules that catch genuine hazards — purity, refs, dependency
         correctness — stay at error, and each one it raised during the
         migration was a real bug that got fixed. */
      'react-hooks/set-state-in-effect': 'warn',
      // Without these, every component referenced only inside JSX reads as an
      // unused import and the real warnings drown in the noise.
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      'no-restricted-globals': [
        'error',
        {
          name: 'confirm',
          message:
            'Use <ConfirmDialog> from patterns/. window.confirm cannot be styled, blocks the main thread, and is suppressed entirely by some mobile browsers — which silently turns a confirmation into an unconditional action.',
        },
        {
          name: 'alert',
          message: 'Use the toast from useToast() so the message is announced to a screen reader (A7/A10).',
        },
        {
          name: 'prompt',
          message: 'Use a <FormDialog> so the input is labelled, validated and keyboard-accessible (§3.5, A5).',
        },
      ],
    },
  },

  /* ── Token discipline: applies to everything that renders ──────────────── */
  {
    files: ['src/**/*.{js,jsx}'],
    ignores: ['src/**/*.test.{js,jsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=/${BANNED_PALETTE}/]`,
          message:
            'Stock Tailwind and legacy palette classes are not available. Use a semantic token — bg-card, text-foreground, border-border, bg-destructive-wash (§2.2, §6).',
        },
        {
          selector: `TemplateElement[value.raw=/${BANNED_PALETTE}/]`,
          message:
            'Stock Tailwind and legacy palette classes are not available. Use a semantic token (§2.2, §6).',
        },
        {
          selector: `Literal[value=/${ARBITRARY_SPACING}/]`,
          message:
            'Arbitrary spacing is prohibited, including "just this once" 1–2px nudges. Use a spacing token (p-s3, gap-s2) or fix the layout structurally (§2.3, §6).',
        },
        {
          selector: `Literal[value=/${ARBITRARY_TYPE}/]`,
          message:
            'Arbitrary type values are prohibited — 14px is the floor and the scale has five steps. Use text-base/sm/md/lg (§2.1, §6).',
        },
        {
          selector: `Literal[value=/${ARBITRARY_SHAPE}/]`,
          message:
            'Arbitrary radius, shadow or duration values are prohibited. Use rounded-control/pill/card, shadow-1/2, duration-instant (§2.4, §6).',
        },
        {
          selector: `Literal[value=/${ARBITRARY_COLOR}/]`,
          message:
            'Raw colours must never appear in component code — resolve through a semantic token from tokens.css (§2.2, §6).',
        },
        {
          selector: `Literal[value=/${RAW_COLOR}/]`,
          message:
            'Raw colour values must never appear in component code — resolve through a semantic token from tokens.css (§6).',
        },
        {
          // The recurring defect class in CLAUDE.md: a component defined inside
          // another gets a new identity every render, so React remounts the
          // subtree and the input loses focus after one keystroke.
          selector:
            'FunctionDeclaration > BlockStatement > VariableDeclaration > VariableDeclarator[id.name=/^[A-Z]/][init.type=/ArrowFunctionExpression|FunctionExpression/]',
          message:
            'Do not define a component inside another component. It gets a new identity on every parent render, React remounts its subtree, and inputs lose focus after one keystroke. Hoist it to module scope — see ui/Field.jsx.',
        },
        {
          selector: `Literal[value=/(^|\\s)(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-s7(\\s|$)/]`,
          message:
            'space.7 (101.77px) is reserved for page-level layout and must not appear inside a component (§2.3, §6).',
        },
      ],
    },
  },

  /* ── Layer boundaries ─────────────────────────────────────────────────────
     ui/ is presentational and knows nothing about pharmacies. Without this,
     a single "just import stock.js here" is all it takes for the design
     system to start depending on the domain again.                          */
  {
    files: ['src/ui/**/*.{js,jsx}'],
    ignores: ['src/ui/**/*.test.{js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/domain/**', '**/patterns/**', '**/components/**', '**/hooks/**'],
              message:
                'ui/ must not import from domain/, patterns/, components/ or hooks/. It knows tokens and props, nothing about pharmacies. Move the pharmacy-aware part into domain/.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['src/domain/**/*.{js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/patterns/**', '**/components/**'],
              message:
                'domain/ must not import from patterns/ or components/. It carries pharmacy meaning but stays route-agnostic.',
            },
          ],
        },
      ],
    },
  },

  /* ── Tests and config need the raw values the rules above ban ──────────── */
  {
    files: ['**/*.test.{js,jsx}', 'src/test/**', '*.config.js', 'tools/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },
];
