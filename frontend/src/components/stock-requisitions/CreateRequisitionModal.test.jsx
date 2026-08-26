import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateRequisitionModal from './CreateRequisitionModal';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const MED_A = '11111111-2222-4333-8444-555555555555';
const MED_B = '99999999-8888-4777-8666-555555555555';

const LOW_STOCK = [
  { id: MED_A, name: 'Dolo 650', generic_name: 'Paracetamol', unit: 'strips', total_stock: 3, low_stock_threshold: 20 },
  { id: MED_B, name: 'Pan 40', generic_name: 'Pantoprazole', unit: 'strips', total_stock: 0, low_stock_threshold: 15 },
];

/* Medico is CHEAPER than Alpha, and is deliberately not first in the array —
   the API sorts, but the component must not depend on array order to decide
   what "cheapest" means. */
const VENDORS = {
  [MED_A]: [
    { supplier_id: 's-medico', supplier_name: 'Medico Agencies', last_unit_cost: 103.12, last_mrp: 120, last_purchased_on: '2026-08-01' },
    { supplier_id: 's-alpha', supplier_name: 'Alpha Pharma', last_unit_cost: 109, last_mrp: 120, last_purchased_on: '2026-07-19' },
    { supplier_id: 's-new', supplier_name: 'New Traders', last_unit_cost: null, last_mrp: null, last_purchased_on: null },
  ],
  [MED_B]: [
    { supplier_id: 's-new', supplier_name: 'New Traders', last_unit_cost: null, last_mrp: null, last_purchased_on: null },
  ],
};

function routeGet(url) {
  if (url.startsWith('/stock-requisitions/low-stock')) {
    return Promise.resolve({ data: { medicines: LOW_STOCK } });
  }
  if (url.startsWith('/stock-requisitions/vendor-prices')) {
    const ids = new URL(`http://x${url}`).searchParams.get('medicine_ids').split(',');
    return Promise.resolve({
      data: { vendors: Object.fromEntries(ids.map((id) => [id, VENDORS[id] || []])) },
    });
  }
  return Promise.resolve({ data: {} });
}

const renderModal = (props = {}) => render(
  <CreateRequisitionModal open onOpenChange={() => {}} onCreated={() => {}} {...props} />
);

/** Open the low-stock panel and tick everything it offers. */
async function addAllLowStock(user) {
  await user.click(screen.getByRole('button', { name: /running low/i }));
  await screen.findByLabelText(/Dolo 650/);
  await user.click(screen.getByRole('button', { name: /Select all/i }));
  await user.click(screen.getByRole('button', { name: /^Add \d+ medicines?$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(routeGet);
  api.post.mockResolvedValue({ data: { requisition: {} }, message: 'ok' });
});

describe('adding from the low-stock list', () => {
  test('ticking several adds them all in ONE vendor-price request', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);

    expect(await screen.findByText('Dolo 650')).toBeInTheDocument();
    expect(screen.getByText('Pan 40')).toBeInTheDocument();

    // The whole point of the batched hook: two medicines, one lookup.
    const priceCalls = api.get.mock.calls.filter(([u]) => u.includes('vendor-prices'));
    expect(priceCalls).toHaveLength(1);
    expect(priceCalls[0][0]).toContain(`${MED_A},${MED_B}`);
  });

  test('shows how far below its reorder level each one is', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('button', { name: /running low/i }));

    const row = (await screen.findByLabelText(/Dolo 650/)).closest('label');
    // "3 strips" only means something next to the 20 it fell below.
    expect(within(row).getByText(/of 20/)).toBeInTheDocument();
  });

  test('a medicine already on the request is not offered twice', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);

    await user.click(screen.getByRole('button', { name: /running low/i }));
    expect(await screen.findByText(/already on this request/i)).toBeInTheDocument();
  });
});

describe('the vendor dropdown', () => {
  test('pre-selects the cheapest distributor', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);

    const select = await screen.findByLabelText(/Distributor for Dolo 650/);
    await waitFor(() => expect(select).toHaveValue('s-medico'));
  });

  test('labels the cheapest and shows what it saves', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);

    const select = await screen.findByLabelText(/Distributor for Dolo 650/);
    await waitFor(() => expect(select).toHaveValue('s-medico'));

    expect(within(select).getByText(/Medico Agencies.*\(lowest\)/)).toBeInTheDocument();
    // The difference IS the decision the feature exists to support.
    expect(screen.getByText(/cheaper than Alpha Pharma/)).toBeInTheDocument();
  });

  test('lists distributors we have never bought from, marked as such', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);

    const select = await screen.findByLabelText(/Distributor for Dolo 650/);
    expect(within(select).getByText(/New Traders — no rate on record/)).toBeInTheDocument();
  });

  test('a medicine with no priced vendor still offers the roster and stays submittable', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);

    const select = await screen.findByLabelText(/Distributor for Pan 40/);
    expect(within(select).getByText(/New Traders/)).toBeInTheDocument();
    // Nothing is pre-selected, because nothing has a rate to be cheapest.
    await waitFor(() => expect(select).toHaveValue(''));

    // And it does not block the send — "we need this and I don't know who from"
    // is exactly the request the owner most needs to see.
    await user.click(screen.getByRole('button', { name: /Send to owner/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
  });
});

describe('what is submitted', () => {
  test('sends the chosen vendor and NO prices', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);
    await waitFor(async () =>
      expect(await screen.findByLabelText(/Distributor for Dolo 650/)).toHaveValue('s-medico'));

    await user.click(screen.getByRole('button', { name: /Send to owner/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());

    const [, body] = api.post.mock.calls[0];
    const dolo = body.items.find((i) => i.medicine_id === MED_A);

    // The default the user accepted without touching is submitted, not dropped.
    expect(dolo.supplier_id).toBe('s-medico');
    // Money is the server's business. A rate posted from a browser is a rate
    // anybody can choose, and this document is one the owner spends against.
    expect(dolo).not.toHaveProperty('unit_cost');
    expect(dolo).not.toHaveProperty('mrp');
    expect(dolo).not.toHaveProperty('supplier_name');
  });

  test('an explicitly cleared vendor is not silently re-defaulted', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);

    const select = await screen.findByLabelText(/Distributor for Dolo 650/);
    await waitFor(() => expect(select).toHaveValue('s-medico'));
    await user.selectOptions(select, '');
    expect(select).toHaveValue('');

    await user.click(screen.getByRole('button', { name: /Send to owner/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());

    const [, body] = api.post.mock.calls[0];
    expect(body.items.find((i) => i.medicine_id === MED_A).supplier_id).toBeNull();
  });
});

describe('quantity', () => {
  test('keeps focus across every keystroke (the nested-component regression)', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);

    const qty = await screen.findByLabelText(/Quantity of Dolo 650/);
    await user.clear(qty);
    await user.type(qty, '150');

    // If a subcomponent were defined inside the parent, this would be '1'.
    expect(qty).toHaveValue('150');
    expect(qty).toHaveFocus();
  });

  test('an empty quantity blocks the send with a sentence naming the medicine', async () => {
    const user = userEvent.setup();
    renderModal();
    await addAllLowStock(user);

    const qty = await screen.findByLabelText(/Quantity of Dolo 650/);
    await user.clear(qty);
    await user.click(screen.getByRole('button', { name: /Send to owner/i }));

    expect(await screen.findByText(/Dolo 650 needs a quantity of at least 1/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});

test('an empty request explains itself instead of being silently disabled', async () => {
  const user = userEvent.setup();
  renderModal();

  await user.click(screen.getByRole('button', { name: /Send to owner/i }));
  expect(await screen.findByText(/Add at least one medicine/)).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});
