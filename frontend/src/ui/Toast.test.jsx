import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from './Toast';
import Button from './Button';

/* Fourteen pages each held a single `toast` string with a setTimeout. Two
   failures in a row showed one message, so a user could act on incomplete
   information — and none of them announced anything to a screen reader. */

function Harness() {
  const toast = useToast();
  return (
    <div>
      <Button onClick={() => toast.success('Sale completed')}>Complete Sale</Button>
      <Button onClick={() => toast.error('Only 4 strips in stock')}>Fail once</Button>
      <Button onClick={() => toast.error('Card reader is offline')}>Fail twice</Button>
    </div>
  );
}

const renderHarness = () => render(<ToastProvider><Harness /></ToastProvider>);

describe('Toast', () => {
  it('queues messages instead of overwriting them', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'Fail once' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fail twice' }));

    // Both survive — the old single-string state kept only the last one.
    expect(screen.getByText('Only 4 strips in stock')).toBeInTheDocument();
    expect(screen.getByText('Card reader is offline')).toBeInTheDocument();
  });

  it('announces errors assertively and confirmations politely', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'Complete Sale' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fail once' }));

    const polite = screen.getByRole('status');
    const assertive = screen.getByRole('alert');

    expect(polite).toHaveAttribute('aria-live', 'polite');
    expect(polite).toHaveTextContent('Sale completed');
    expect(assertive).toHaveAttribute('aria-live', 'assertive');
    expect(assertive).toHaveTextContent('Only 4 strips in stock');
  });

  it('can be dismissed by hand', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'Complete Sale' }));
    expect(screen.getByText('Sale completed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Sale completed')).not.toBeInTheDocument();
  });

  it('keeps both live regions mounted before any message arrives', () => {
    renderHarness();
    // A live region inserted at the same moment as its content is not
    // reliably announced, so they have to exist up front.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
