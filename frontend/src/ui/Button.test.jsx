import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Button from './Button';

/* Regression: `asChild` used to wrap `children` in Button's own <span> plus a
   `{loading && ...}` sibling before handing them to Radix's `Slot`, which
   requires exactly one element child to clone props onto. That combination
   made every `<Button asChild>` throw the moment it rendered — "Slot failed
   to slot onto its children" — with no warning until something actually used
   it, which is exactly how it reached production undetected. */

describe('Button asChild', () => {
  it('clones its props onto the single child element instead of wrapping it', () => {
    render(
      <Button asChild variant="secondary" size="compact" className="extra-class">
        <a href="https://example.test/doc.pdf" target="_blank" rel="noreferrer noopener">
          Open full size
        </a>
      </Button>
    );

    const link = screen.getByRole('link', { name: 'Open full size' });
    expect(link).toHaveAttribute('href', 'https://example.test/doc.pdf');
    // Slot merges Button's classes onto the <a> itself — there is no wrapper.
    expect(link).toHaveClass('extra-class');
    expect(link.tagName).toBe('A');
  });

  it('still renders the native button normally when asChild is absent', () => {
    render(<Button variant="primary">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('shows the loading spinner on the native path without asChild', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });
});
