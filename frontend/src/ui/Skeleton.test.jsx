import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Skeleton, { SkeletonRegion, SkeletonRows, SkeletonTable } from './Skeleton';
import Table from './Table';

/* The two properties a skeleton has to keep, whatever it is standing in for:
   the bars are invisible to assistive tech, and the wait is still announced
   exactly once (A10). Everything else about a skeleton is geometry. */

describe('Skeleton — what a screen reader gets', () => {
  it('hides every bar from the accessibility tree', () => {
    const { container } = render(<SkeletonRows count={3} leading />);
    const bars = container.querySelectorAll('.animate-pulse');
    expect(bars.length).toBeGreaterThan(0);
    bars.forEach((bar) => expect(bar).toHaveAttribute('aria-hidden', 'true'));
  });

  it('announces the wait once, naming what is being waited for', () => {
    render(
      <SkeletonRegion label="Loading medicines…">
        <SkeletonRows count={4} />
      </SkeletonRegion>
    );

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    // One region, one sentence — not one per bar.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText('Loading medicines…')).toBeInTheDocument();
  });

  it('refuses to render a silent region', () => {
    // Same discipline as EmptyState: the label cannot be forgotten, because a
    // skeleton with no label is a wait nobody is told about.
    expect(() =>
      render(<SkeletonRegion><Skeleton className="h-4" /></SkeletonRegion>)
    ).toThrow(/requires a `label`/i);
  });
});

describe('SkeletonTable — §3.7, both breakpoints', () => {
  it('stands in for the table AND the stacked card it collapses into', () => {
    const { container } = render(<SkeletonTable columns={3} rows={2} actions />);

    // The desktop half carries the table chrome; the mobile half is separate
    // markup, not the same nodes restyled — matching how Table itself works.
    expect(container.querySelector('.md\\:block')).toBeInTheDocument();
    expect(container.querySelector('.md\\:hidden')).toBeInTheDocument();
  });
});

describe('Table — the loading branch', () => {
  const COLUMNS = [
    { key: 'name', label: 'Medicine' },
    { key: 'stock', label: 'In stock', numeric: true },
  ];

  it('announces the load with the resource name and renders no rows', () => {
    render(
      <Table
        columns={COLUMNS}
        rows={[{ id: '1', name: 'Metformin 500mg', stock: 42 }]}
        loading
        itemNoun="medicines"
        emptyTitle="No medicines yet"
        emptyBody="Add your first medicine to get started."
      />
    );

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading medicines…')).toBeInTheDocument();
    // Loading is not "the data, faintly" — nothing from the rows is on screen.
    expect(screen.queryByText('Metformin 500mg')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
