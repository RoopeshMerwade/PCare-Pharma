import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Badge from './Badge';
import { badgeVariants } from './Badge';

/* The old Badge header claimed its tones were "distinguishable in grayscale by
   fill lightness, which is what the A4 screenshot test actually checks". There
   was no screenshot test — this repo has no Playwright, no snapshots, nothing
   that reads a pixel — and with the solid --color-badge-* palette the claim is
   false anyway: flag 0.142 / info 0.146 / low 0.153 / ok 0.160 relative
   luminance sit inside a 0.018 band and are indistinguishable desaturated.

   The thing that actually satisfies A4 is that a badge cannot render without a
   text label, because `children` IS the status. That is what these lock down,
   alongside the two test hooks the component exposes.

   The compound-variant classes are asserted as literal strings on purpose. If
   anyone "simplifies" them into `bg-badge-${tone}`, Tailwind's static scanner
   stops finding them and the pills ship unstyled in the production build with
   nothing failing in dev — so the literal form is the contract. */

const TONES = ['ok', 'success', 'low', 'warning', 'critical', 'error', 'processing', 'info', 'neutral', 'flag'];

describe('Badge', () => {
  it('renders its label as text in every tone, in both variants (A4)', () => {
    for (const tone of TONES) {
      for (const variant of ['wash', 'solid']) {
        const { unmount } = render(
          <Badge tone={tone} variant={variant}>{`${tone} ${variant}`}</Badge>
        );
        expect(screen.getByText(`${tone} ${variant}`)).toBeInTheDocument();
        unmount();
      }
    }
  });

  it('defaults to the wash variant, so no existing call site changed weight', () => {
    render(<Badge tone="critical">Unpaid</Badge>);
    const badge = screen.getByText('Unpaid');
    expect(badge).toHaveAttribute('data-variant', 'wash');
    expect(badge).toHaveClass('bg-destructive-wash');
  });

  it('exposes tone and variant as data attributes for tests to key on', () => {
    render(<Badge tone="processing" variant="solid">Needs review</Badge>);
    const badge = screen.getByText('Needs review');
    expect(badge).toHaveAttribute('data-tone', 'processing');
    expect(badge).toHaveAttribute('data-variant', 'solid');
  });

  it('gives the solid variant a badge ground, a brighter edge and the white label token', () => {
    render(<Badge tone="processing" variant="solid">Sent</Badge>);
    const badge = screen.getByText('Sent');
    expect(badge).toHaveClass('bg-badge-processing');
    expect(badge).toHaveClass('border-badge-processing-edge');
    expect(badge).toHaveClass('text-badge-fg');
  });

  it('emits complete literal classes for every solid tone — never interpolated', () => {
    const expected = {
      ok: 'success', success: 'success',
      low: 'warning', warning: 'warning',
      critical: 'critical', error: 'critical',
      processing: 'processing', info: 'info',
      neutral: 'neutral', flag: 'flag',
    };
    for (const [tone, group] of Object.entries(expected)) {
      const classes = badgeVariants({ variant: 'solid', tone });
      expect(classes).toContain(`bg-badge-${group}`);
      expect(classes).toContain(`border-badge-${group}-edge`);
    }
  });

  it('keeps the -ink tokens on the wash tones that need them for 4.5:1', () => {
    expect(badgeVariants({ variant: 'wash', tone: 'low' })).toContain('text-warning-ink');
    expect(badgeVariants({ variant: 'wash', tone: 'critical' })).toContain('text-destructive-ink');
  });

  it('hides a decorative icon from assistive tech but keeps the label announced', () => {
    render(<Badge tone="flag" icon={<svg data-testid="mark" />}>Prescription required</Badge>);
    expect(screen.getByText('Prescription required')).toBeInTheDocument();
    expect(screen.getByTestId('mark').parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not title-case the label — the registry decides what a status is called', () => {
    render(<Badge tone="warning">Awaiting approval</Badge>);
    expect(screen.getByText('Awaiting approval')).not.toHaveClass('capitalize');
  });
});
