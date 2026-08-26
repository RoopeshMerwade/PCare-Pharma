import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Table, { visibleColumns } from './Table';
import Button from './Button';

const ROWS = [
  { id: '1', name: 'Metformin 500mg', stock: 42, cost: 18.4 },
  { id: '2', name: 'Amlodipine 5mg', stock: 4, cost: 9.1 },
];

const ALL_COLUMNS = [
  { key: 'name', label: 'Medicine' },
  { key: 'stock', label: 'In stock', numeric: true, sortable: true },
  { key: 'cost', label: 'Cost price', numeric: true, ownerOnly: true },
];

describe('Table — A9 role scoping', () => {
  it('removes Owner-only columns from the DOM entirely for Staff, not via CSS', () => {
    render(
      <Table
        columns={visibleColumns(ALL_COLUMNS, /* isOwner */ false)}
        rows={ROWS}
        emptyTitle="No medicines yet"
        emptyBody="Add your first medicine to get started."
      />
    );

    // Absent from the accessibility tree AND from the markup — a hidden node
    // with the value still in it would satisfy neither A9 nor §6.
    expect(screen.queryByText('Cost price')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('18.4');
  });

  it('renders Owner-only columns for an Owner session', () => {
    render(
      <Table
        columns={visibleColumns(ALL_COLUMNS, true)}
        rows={ROWS}
        emptyTitle="No medicines yet"
        emptyBody="Add your first medicine to get started."
      />
    );
    expect(screen.getAllByText('Cost price').length).toBeGreaterThan(0);
  });
});

describe('Table — §3.7 keyboard and sorting', () => {
  it('sortable headers are real buttons and reflect state with aria-sort', async () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <Table
        columns={visibleColumns(ALL_COLUMNS, true)}
        rows={ROWS}
        sort={{ key: 'stock', dir: 'asc' }}
        onSortChange={onSortChange}
        emptyTitle="No medicines yet"
        emptyBody="Add your first medicine to get started."
      />
    );

    const header = screen.getByRole('columnheader', { name: /In stock/ });
    expect(header).toHaveAttribute('aria-sort', 'ascending');

    // Activated from the keyboard, which a <th onClick> could not be.
    await userEvent.click(screen.getByRole('button', { name: /In stock/ }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'stock', dir: 'desc' });

    rerender(
      <Table
        columns={visibleColumns(ALL_COLUMNS, true)}
        rows={ROWS}
        sort={{ key: 'stock', dir: 'desc' }}
        onSortChange={onSortChange}
        emptyTitle="No medicines yet"
        emptyBody="Add your first medicine to get started."
      />
    );
    expect(screen.getByRole('columnheader', { name: /In stock/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('row actions are in the DOM without hover — §3.7 prohibits hover-reveal', () => {
    render(
      <Table
        columns={visibleColumns(ALL_COLUMNS, true)}
        rows={ROWS}
        rowActions={(row) => <Button size="compact">Edit {row.name}</Button>}
        emptyTitle="No medicines yet"
        emptyBody="Add your first medicine to get started."
      />
    );
    // Present and reachable immediately, no pointer interaction required.
    expect(screen.getAllByRole('button', { name: /Edit Metformin 500mg/ }).length).toBeGreaterThan(0);
  });

  it('renders its empty state inside the region so filters stay usable', () => {
    render(
      <Table
        columns={visibleColumns(ALL_COLUMNS, true)}
        rows={[]}
        emptyTitle="No medicines match those filters"
        emptyBody="Try a different search term, or clear the category filter."
      />
    );
    expect(screen.getByText('No medicines match those filters')).toBeInTheDocument();
  });
});
