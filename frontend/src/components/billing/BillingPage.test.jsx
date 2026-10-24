import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../ui/Toast';
import BillingPage from './BillingPage';

/* Same-composition substitutes are offered only for a line that cannot be
   filled as it stands — out of stock, low, or asking for more than is on hand.
   Every cart line used to ask the server for them anyway, so a fully stocked
   ten-line bill cost ten requests whose answer was never shown. These pin down
   that only a line that needs substitutes asks, that it asks once per medicine,
   and that a failed, cancelled or late answer never sticks to the wrong line. */

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: mockApi }));

// The real search box debounces and calls /medicines/search; the cart is what
// is under test, so a medicine is added with one click instead.
vi.mock('../../hooks/useMedicineSearch', () => ({
  MedicineSearchInput: ({ onSelect }) => (
    <div>
      {Object.values(MEDS).map((m) => (
        <button key={m.id} type="button" onClick={() => onSelect(m)}>{`Add ${m.name}`}</button>
      ))}
    </div>
  ),
}));

const med = (id, name, { stock = 50, low = false } = {}) => ({
  id, name, generic_name: 'Paracetamol', unit: 'strips', default_selling_price: '20.00',
  total_stock: stock, is_low_stock: low, low_stock_threshold: 10,
  pack_content_quantity: null, pack_content_unit: null, loose_sale_supported: false,
});

const MEDS = {
  dolo: med('m-dolo', 'Dolo 650'),
  crocin: med('m-crocin', 'Crocin 500'),
  calpol: med('m-calpol', 'Calpol 650'),
  low: med('m-low', 'Pacimol 650', { stock: 4, low: true }),
  out: med('m-out', 'Paracip 500', { stock: 0, low: true }),
  few: med('m-few', 'Fevago 650', { stock: 5 }),
};

const altsUrl = (m) => `/medicines/${m.id}/alternatives`;
const altCalls = () => mockApi.get.mock.calls.filter(([url]) => url.endsWith('/alternatives'));
const altCallsFor = (m) => altCalls().filter(([url]) => url === altsUrl(m));
const reply = (alternatives) => Promise.resolve({ data: { alternatives } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const CHECKING = 'Checking for same-composition substitutes…';
const panel = () => screen.queryByText(/same composition \(paracetamol\) in stock/i);
const flush = () => act(async () => {});

const renderPage = () => render(<ToastProvider><BillingPage /></ToastProvider>);
const add = async (user, m) => {
  await user.click(screen.getByRole('button', { name: `Add ${m.name}` }));
  await flush();
};
const setQty = async (user, m, value) => {
  const box = screen.getByRole('textbox', { name: `Quantity of ${m.name}` });
  await user.clear(box);
  if (value) await user.type(box, value);
  await flush();
};

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.get.mockImplementation(() => reply([]));
});

describe('BillingPage — same-composition substitutes', () => {
  it('a fully stocked cart asks for no substitutes at all', async () => {
    const user = userEvent.setup();
    renderPage();

    await add(user, MEDS.dolo);
    await add(user, MEDS.crocin);
    await add(user, MEDS.calpol);

    expect(screen.getByText('Dolo 650')).toBeInTheDocument();
    expect(screen.getByText('Calpol 650')).toBeInTheDocument();
    expect(altCalls()).toHaveLength(0);
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
  });

  it('only the line that needs substitutes asks, and its answer is shown', async () => {
    const user = userEvent.setup();
    mockApi.get.mockImplementation((url) => (url === altsUrl(MEDS.low) ? reply([MEDS.dolo]) : reply([])));
    renderPage();

    await add(user, MEDS.crocin);
    await add(user, MEDS.low);

    expect(altCalls()).toHaveLength(1);
    expect(altCallsFor(MEDS.low)).toHaveLength(1);
    expect(panel()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Swap Pacimol 650 for Dolo 650/ })).toBeInTheDocument();
  });

  it('an out-of-stock line asks for substitutes as soon as it is added', async () => {
    const user = userEvent.setup();
    mockApi.get.mockImplementation(() => reply([MEDS.dolo]));
    renderPage();

    await add(user, MEDS.out);

    expect(altCallsFor(MEDS.out)).toHaveLength(1);
    expect(panel()).toBeInTheDocument();
  });

  it('asking for more than is in stock fetches once, not on every keystroke', async () => {
    const user = userEvent.setup();
    mockApi.get.mockImplementation(() => reply([MEDS.dolo]));
    renderPage();

    await add(user, MEDS.few);                         // 5 in stock, qty 1
    expect(altCalls()).toHaveLength(0);

    await setQty(user, MEDS.few, '60');                // "6" then "60": both exceed stock
    expect(altCallsFor(MEDS.few)).toHaveLength(1);
    expect(panel()).toBeInTheDocument();

    await setQty(user, MEDS.few, '3');                 // fillable again: panel hides…
    expect(panel()).not.toBeInTheDocument();

    await setQty(user, MEDS.few, '7');                 // …and comes back without a second request
    expect(panel()).toBeInTheDocument();
    expect(altCalls()).toHaveLength(1);
  });

  it('a swap shows the new medicine with no stale substitutes and asks only if the new one needs them', async () => {
    const user = userEvent.setup();
    mockApi.get.mockImplementation((url) => (url === altsUrl(MEDS.low) ? reply([MEDS.dolo]) : reply([MEDS.crocin])));
    renderPage();

    await add(user, MEDS.low);
    await user.click(screen.getByRole('button', { name: /^Swap Pacimol 650 for Dolo 650/ }));
    await flush();

    expect(screen.getByText('Dolo 650')).toBeInTheDocument();
    expect(screen.queryByText('Pacimol 650')).not.toBeInTheDocument();
    expect(panel()).not.toBeInTheDocument();          // Dolo is in stock: nothing to offer, nothing asked
    expect(altCalls()).toHaveLength(1);
    expect(altCallsFor(MEDS.dolo)).toHaveLength(0);
  });

  it('a failed request shows nothing and is retried the next time the line needs substitutes', async () => {
    const user = userEvent.setup();
    mockApi.get
      .mockImplementationOnce(() => Promise.reject(new Error('network down')))
      .mockImplementation(() => reply([MEDS.dolo]));
    renderPage();

    await add(user, MEDS.few);
    await setQty(user, MEDS.few, '6');

    expect(altCalls()).toHaveLength(1);
    expect(panel()).not.toBeInTheDocument();
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();

    await setQty(user, MEDS.few, '2');
    await setQty(user, MEDS.few, '6');

    expect(altCalls()).toHaveLength(2);                // the failure was not remembered as an answer
    expect(panel()).toBeInTheDocument();
  });

  it('a late answer for a request that was cancelled never reaches the line', async () => {
    const user = userEvent.setup();
    const first = deferred();
    const second = deferred();
    mockApi.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderPage();

    await add(user, MEDS.few);
    await setQty(user, MEDS.few, '6');                 // request 1 in flight
    expect(screen.getByText(CHECKING)).toBeInTheDocument();

    await setQty(user, MEDS.few, '2');                 // no longer needed: request 1 is abandoned
    await setQty(user, MEDS.few, '6');                 // needed again: asked again, not suppressed
    expect(altCalls()).toHaveLength(2);

    await act(async () => { first.resolve({ data: { alternatives: [{ ...MEDS.calpol, id: 'stale' }] } }); });
    expect(screen.queryByRole('button', { name: /^Swap Fevago 650 for Calpol 650/ })).not.toBeInTheDocument();
    expect(screen.getByText(CHECKING)).toBeInTheDocument();   // still waiting on request 2

    await act(async () => { second.resolve({ data: { alternatives: [MEDS.crocin] } }); });
    expect(screen.getByRole('button', { name: /^Swap Fevago 650 for Crocin 500/ })).toBeInTheDocument();
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
  });

  it('removing a line while its request is in flight drops the late answer', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    mockApi.get.mockReturnValueOnce(pending.promise);
    renderPage();

    await add(user, MEDS.low);
    expect(altCallsFor(MEDS.low)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove Pacimol 650 from this bill' }));
    await flush();

    await act(async () => { pending.resolve({ data: { alternatives: [MEDS.dolo] } }); });
    expect(screen.queryByText('Pacimol 650')).not.toBeInTheDocument();
    expect(panel()).not.toBeInTheDocument();
  });

  it('every line renders its own substitutes, not another line’s', async () => {
    const user = userEvent.setup();
    mockApi.get.mockImplementation((url) => {
      if (url === altsUrl(MEDS.low)) return reply([MEDS.dolo]);
      if (url === altsUrl(MEDS.out)) return reply([MEDS.calpol]);
      return reply([]);
    });
    renderPage();

    await add(user, MEDS.low);
    await add(user, MEDS.out);

    const lowLine = screen.getByText('Pacimol 650').closest('li');
    const outLine = screen.getByText('Paracip 500').closest('li');
    expect(within(lowLine).getByRole('button', { name: /for Dolo 650/ })).toBeInTheDocument();
    expect(within(outLine).getByRole('button', { name: /for Calpol 650/ })).toBeInTheDocument();
    expect(altCalls()).toHaveLength(2);
  });
});
