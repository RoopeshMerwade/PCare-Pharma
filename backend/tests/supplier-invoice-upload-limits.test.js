/**
 * Module 23 — upload guards: the per-user hourly allowance and the cap on
 * reads in progress. HERMETIC.
 *
 * No network, no credentials — but backend/.env must exist, because app.js
 * validates config at require time. Runs in CI.
 *
 * The service is replaced with a stand-in the test controls, so a read can be
 * held open while a second upload is shown the door. The limits are lowered
 * through the environment BEFORE app.js is required, because env.js reads them
 * once at load; dotenv never overwrites a variable that is already set, so
 * backend/.env cannot undo it.
 */

process.env.INVOICE_UPLOADS_PER_HOUR = '3';
process.env.INVOICE_MAX_CONCURRENT_EXTRACTIONS = '1';

const mockIngest = jest.fn();

// The user comes from a header rather than shared state: two requests in
// flight at once must not be able to see each other's identity.
jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: req.headers['x-test-user'] || 'u1', full_name: 'Test User', is_active: true, role: 'staff' };
    next();
  },
  authorize: (...roles) => (req, res, next) => (
    roles.includes(req.user.role) ? next()
      : next(Object.assign(new Error('You do not have permission to perform this action.'), {
        statusCode: 403, code: 'FORBIDDEN', isOperational: true,
      }))
  ),
}));

jest.mock('../src/config/supabase', () => ({
  supabase: {
    from: () => { throw new Error('unexpected db call'); },
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({}) },
    auth: {},
  },
  createAuthClient: () => ({}),
}));

jest.mock('../src/modules/supplier-invoices/supplier-invoices.service', () => ({
  ingestInvoice: (...args) => mockIngest(...args),
}));

const request = require('supertest');
const app = require('../src/app');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const upload = (user) => request(app)
  .post('/api/v1/supplier-invoices')
  .set('X-Test-User', user)
  .attach('file', PNG, { filename: 'invoice.png', contentType: 'image/png' });

beforeEach(() => {
  mockIngest.mockReset();
  mockIngest.mockResolvedValue({ id: 'inv-1', status: 'NEEDS_REVIEW' });
});

test('each user has their own hourly allowance', async () => {
  for (let i = 0; i < 3; i += 1) {
    expect((await upload('asha')).status).toBe(201);
  }
  const refused = await upload('asha');
  expect([refused.status, refused.body.error]).toEqual([429, 'RATE_LIMITED']);

  // The shop shares one IP. A colleague is not locked out by Asha's uploads.
  expect((await upload('ravi')).status).toBe(201);
  expect(mockIngest).toHaveBeenCalledTimes(4);
});

test('an upload refused before the read still frees the slot', async () => {
  const wrongType = await request(app)
    .post('/api/v1/supplier-invoices')
    .set('X-Test-User', 'meena')
    .attach('file', Buffer.from('x'), { filename: 'notes.txt', contentType: 'text/plain' });
  expect(wrongType.status).toBe(422);

  expect((await upload('meena')).status).toBe(201);
});

// Last on purpose. Every request above has come and gone by now, so a slot
// released twice — on 'finish' AND on 'close' — would have driven the counter
// below zero, and the second upload here would wrongly be let through.
test('one invoice is read at a time; the next is told to wait, then succeeds', async () => {
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  let markReading;
  const reading = new Promise((resolve) => { markReading = resolve; });
  mockIngest.mockImplementationOnce(async () => {
    markReading();
    await gate;
    return { id: 'inv-slow', status: 'NEEDS_REVIEW' };
  });

  const first = upload('kiran').then((res) => res);
  await reading;

  // The gate opens in `finally`, so a missing slot fails this test instead of
  // leaving the first request open and hanging the whole run.
  let second;
  try {
    second = await upload('divya');
  } finally {
    openGate();
  }
  expect([second.status, second.body.error]).toEqual([429, 'EXTRACTION_BUSY']);
  expect((await first).status).toBe(201);
  expect((await upload('divya')).status).toBe(201);
});
