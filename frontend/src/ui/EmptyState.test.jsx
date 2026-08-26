import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EmptyState from './EmptyState';

/* §6 prohibits a generic "No data" anywhere in the app. The component is the
   enforcement point: these tests assert you cannot ship one by accident. */

describe('EmptyState — §5 / §6 content rules', () => {
  it('refuses to render without context-specific copy', () => {
    // Both halves are required; a shared default is the thing being prevented.
    expect(() => render(<EmptyState title="No sales yet today" />)).toThrow(/requires both/i);
    expect(() => render(<EmptyState />)).toThrow(/requires both/i);
  });

  it('rejects generic placeholder titles outright', () => {
    expect(() =>
      render(<EmptyState title="No data available" body="Nothing to see." />)
    ).toThrow(/generic placeholder/i);
  });

  it('renders specific copy and an optional recovery action', () => {
    render(
      <EmptyState
        title="No sales yet today"
        body="They'll show up here as they're rung up."
      />
    );
    expect(screen.getByText('No sales yet today')).toBeInTheDocument();
    expect(screen.getByText("They'll show up here as they're rung up.")).toBeInTheDocument();
  });
});
