import { describe, it, expect, useState as _unused } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Field from './Field';
import Input, { NumericInput } from './Input';

/* The regression test this whole layer exists to make redundant.

   CLAUDE.md records the bug: a Field defined inside the parent component gets
   a fresh identity on every render, React remounts the subtree, and the input
   loses focus after one keystroke — "the form only accepts one character".
   It was found and fixed three separate times.

   Typing several characters into a controlled Field and asserting the whole
   string arrived is the cheapest possible guard against it coming back. */
function ControlledForm() {
  const [value, setValue] = useState('');
  return (
    <Field label="Brand / trade name" required>
      <Input value={value} onChange={(e) => setValue(e.target.value)} />
    </Field>
  );
}

describe('Field — focus retention regression (CLAUDE.md defect class)', () => {
  it('keeps focus across many keystrokes in a controlled input', async () => {
    render(<ControlledForm />);
    const input = screen.getByLabelText(/Brand \/ trade name/);

    await userEvent.click(input);
    await userEvent.keyboard('Metformin');

    // If Field were re-created per render, this would be 'M'.
    expect(input).toHaveValue('Metformin');
    expect(input).toHaveFocus();
  });

  it('links label, hint and error to the control without the caller wiring ids (A7)', () => {
    render(
      <Field label="Quantity" hint="strips" error="Quantity exceeds available stock (12 in stock)">
        <Input />
      </Field>
    );

    const input = screen.getByLabelText(/Quantity/);
    const error = screen.getByRole('alert');

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', error.getAttribute('id'));
    // The message says what is wrong AND how to fix it — not "Invalid value".
    expect(error).toHaveTextContent('12 in stock');
  });

  it('clicking the label focuses the control', async () => {
    render(
      <Field label="Low stock alert at">
        <Input />
      </Field>
    );
    await userEvent.click(screen.getByText(/Low stock alert at/));
    expect(screen.getByLabelText(/Low stock alert at/)).toHaveFocus();
  });
});

function ControlledQty() {
  const [value, setValue] = useState('');
  return (
    <Field label="Quantity">
      <NumericInput integer value={value} onChange={setValue} />
    </Field>
  );
}

describe('NumericInput — §3.5 pharmacy rule', () => {
  it('rejects non-numeric characters at the keystroke, not at submit', async () => {
    render(<ControlledQty />);
    const input = screen.getByLabelText('Quantity');

    await userEvent.type(input, '12abc3');
    expect(input).toHaveValue('123');
  });

  it('never silently clamps — an over-large quantity stays on screen to be corrected', async () => {
    render(<ControlledQty />);
    const input = screen.getByLabelText('Quantity');

    await userEvent.type(input, '400');
    // Even though only 12 might be in stock, the typed value is preserved so
    // the caller can say so. Clamping to 12 here is how sales get rung up wrong.
    expect(input).toHaveValue('400');
  });

  it('offers the digit keypad on tablets', () => {
    render(<ControlledQty />);
    expect(screen.getByLabelText('Quantity')).toHaveAttribute('inputmode', 'numeric');
  });
});
