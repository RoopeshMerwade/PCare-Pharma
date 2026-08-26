import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogBody } from './Dialog';
import Button from './Button';

/* A5 and A10 are what the sixteen hand-rolled overlays failed, and they failed
   invisibly — the modal still looked right. These assert the behaviours that
   are impossible to see in a screenshot. */

function Harness() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Add medicine</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader title="Add medicine to catalog" />
        <DialogBody>
          <input aria-label="Brand name" />
          <Button>Save</Button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog — A5 / A10', () => {
  it('Escape closes it', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add medicine' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('returns focus to the trigger on close, rather than dropping it to body', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Add medicine' });

    await userEvent.click(trigger);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');

    expect(trigger).toHaveFocus();
  });

  it('is labelled by its title and hides the rest of the page from assistive tech', async () => {
    render(
      <div data-testid="page-behind">
        <Harness />
      </div>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add medicine' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Add medicine to catalog');

    // Radix enforces modality by removing everything outside the dialog from
    // the accessibility tree, rather than by setting aria-modal. That is the
    // stronger of the two — aria-modal asks the screen reader to cooperate,
    // aria-hidden leaves it no choice.
    const behind = screen.getByTestId('page-behind');
    expect(behind.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('traps focus inside — Tab cannot reach the page behind', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add medicine' }));
    const dialog = await screen.findByRole('dialog');

    // Cycle well past the number of focusable elements in the dialog.
    for (let i = 0; i < 8; i += 1) await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement);
  });
});
