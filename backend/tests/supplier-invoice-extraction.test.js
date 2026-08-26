/**
 * MODULE 23 — Gemini extraction client (hermetic: `fetch` is mocked)
 * Runner: npx jest tests/supplier-invoice-extraction.test.js --runInBand
 *
 * No API calls, no credentials, no cost. What is asserted is the CONTRACT with
 * the Generative Language API — the request shape and every failure branch —
 * because that is the part of this feature with no other safety net: extraction
 * quality is a human's job to check on the review screen, but a request that
 * silently drops `responseSchema`, or a truncated response parsed as a short
 * line list, is a defect no reviewer could see.
 *
 * The two retry tests sleep for real (800ms backoff), which is why this suite
 * takes a couple of seconds rather than milliseconds.
 */

// Every GEMINI_* var is pinned here rather than left to inherit from the real
// backend/.env — this suite has to pass identically whether or not that file
// has a live key and regardless of which model it points at, or a change made
// for live testing silently breaks CI.
process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'gemini-test-model';
process.env.GEMINI_MAX_ATTEMPTS = '2';
jest.resetModules();

const { extractInvoice } = require('../src/modules/supplier-invoices/supplier-invoices.extraction');
const BUF = Buffer.from('fake-pdf-bytes');
const TEST_MODEL = 'gemini-test-model';

const okBody = (obj, extra = {}) => ({
  ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, ...extra }], usageMetadata: { totalTokenCount: 10 } }),
});

afterEach(() => { delete global.fetch; jest.clearAllMocks(); });

test('sends inlineData + responseSchema + temperature 0, and keys go in the header not the URL', async () => {
  let captured;
  global.fetch = jest.fn(async (url, init) => { captured = { url, init }; return okBody({ line_items: [] }); });

  const out = await extractInvoice(BUF, 'application/pdf');
  expect(out.raw).toEqual({ line_items: [] });
  expect(out.model).toBe(TEST_MODEL);
  expect(typeof out.elapsedMs).toBe('number');

  expect(captured.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${TEST_MODEL}:generateContent`);
  expect(captured.url).not.toContain('test-key');
  expect(captured.init.headers['x-goog-api-key']).toBe('test-key');

  const body = JSON.parse(captured.init.body);
  expect(body.generationConfig.temperature).toBe(0);
  expect(body.generationConfig.responseMimeType).toBe('application/json');
  expect(body.generationConfig.responseSchema.properties.line_items.type).toBe('ARRAY');
  const parts = body.contents[0].parts;
  expect(parts[0].text).toContain('NEVER invent');
  expect(parts[1].inlineData).toEqual({ mimeType: 'application/pdf', data: BUF.toString('base64') });
});

test('MAX_TOKENS is an error, not a silently short line list', async () => {
  global.fetch = jest.fn(async () => okBody({ line_items: [{ description: 'A' }] }, { finishReason: 'MAX_TOKENS' }));
  await expect(extractInvoice(BUF, 'image/png')).rejects.toMatchObject({ code: 'EXTRACTION_TRUNCATED', statusCode: 422 });
});

test('a safety block is reported as 422, not a 500', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) }));
  await expect(extractInvoice(BUF, 'image/png')).rejects.toMatchObject({ code: 'EXTRACTION_BLOCKED' });
});

test('unparseable text despite responseSchema is EXTRACTION_MALFORMED', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{oops' }] } }] }) }));
  await expect(extractInvoice(BUF, 'image/png')).rejects.toMatchObject({ code: 'EXTRACTION_MALFORMED' });
});

test('empty output is EXTRACTION_EMPTY', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [] } }] }) }));
  await expect(extractInvoice(BUF, 'image/png')).rejects.toMatchObject({ code: 'EXTRACTION_EMPTY' });
});

test('503 is retried once then reported; 401 is not retried', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 503, text: async () => 'unavailable' }));
  await expect(extractInvoice(BUF, 'image/png')).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
  expect(global.fetch).toHaveBeenCalledTimes(2);

  global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' }));
  await expect(extractInvoice(BUF, 'image/png')).rejects.toMatchObject({ code: 'EXTRACTION_UNAUTHORIZED' });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('a retired/unknown model (404) is EXTRACTION_MODEL_UNAVAILABLE, not retried, and not confused with a per-document failure', async () => {
  // Regression: Google retires model ids on notice (this is the exact shape
  // gemini-2.5-flash's retirement took against a live key) and a 404 here is a
  // deployment misconfiguration, not something a different document or a
  // retry would fix. It must stay out of RETRYABLE_STATUS and out of the
  // generic EXTRACTION_FAILED bucket, or the failure looks transient when it
  // is total and identical across every upload until GEMINI_MODEL is fixed.
  global.fetch = jest.fn(async () => ({
    ok: false, status: 404,
    text: async () => JSON.stringify({ error: { code: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users.', status: 'NOT_FOUND' } }),
  }));
  await expect(extractInvoice(BUF, 'image/png')).rejects.toMatchObject({ code: 'EXTRACTION_MODEL_UNAVAILABLE', statusCode: 502 });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('a retry that succeeds returns the answer', async () => {
  let n = 0;
  global.fetch = jest.fn(async () => (++n === 1 ? { ok: false, status: 429, text: async () => 'slow down' } : okBody({ line_items: [{ description: 'B' }] })));
  const out = await extractInvoice(BUF, 'image/png');
  expect(out.raw.line_items).toHaveLength(1);
});

test('a network failure is EXTRACTION_UNREACHABLE, and a timeout is EXTRACTION_TIMEOUT', async () => {
  global.fetch = jest.fn(async () => { throw new TypeError('fetch failed'); });
  await expect(extractInvoice(BUF, 'image/png')).rejects.toMatchObject({ code: 'EXTRACTION_UNREACHABLE' });

  global.fetch = jest.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  await expect(extractInvoice(BUF, 'image/png')).rejects.toMatchObject({ code: 'EXTRACTION_TIMEOUT', statusCode: 504 });
});
