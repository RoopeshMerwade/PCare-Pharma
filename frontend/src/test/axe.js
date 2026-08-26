import { axe } from 'vitest-axe';

/**
 * axe against a rendered component.
 *
 * `color-contrast` is switched off here because jsdom has no layout or paint —
 * axe falls back to canvas, which jsdom does not implement, and the rule
 * reports nothing useful either way. Contrast is verified where it can
 * actually be measured: against the token values (see tokens.css, every
 * extension carries its ratio) and in the browser axe pass of the a11y sweep.
 */
export function checkA11y(container, options = {}) {
  return axe(container, {
    ...options,
    rules: {
      'color-contrast': { enabled: false },
      ...(options.rules || {}),
    },
  });
}
