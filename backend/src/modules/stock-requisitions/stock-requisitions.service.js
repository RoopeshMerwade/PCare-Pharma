// ── Module 30: Stock Requisitions
// ── Role: Service (business logic only — no HTTP knowledge)
//
// The permission model of this module is three sentences:
//   · anyone may raise a request, and read the ones they raised;
//   · only the owner may approve, reject, or download;
//   · only the person who raised a request may withdraw it.
// The first lives in `scopeToActor` / `assertCanAccess`, the second on the
// routes, the third in `cancelRequisition` — and each is in exactly one place,
// so no endpoint added later can quietly forget half of one.
//
// THIS MODULE WRITES NO STOCK. It creates no batch, no ledger row and no
// purchase order. Approving marks a record approved and unlocks a download;
// the goods arrive through Module 05, 08 or 23 like everything else. That
// absence is the design, not an omission — do not "complete" it by having
// approve raise a PO.

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { mapDbError } = require('../../utils/dbErrors');
const { logAudit } = require('../../utils/audit');
const { assertCanAccess } = require('../../utils/authz');
const { createNotification } = require('../notifications/notifications.service');

// Columns of stock_requisitions_with_totals. Named rather than `*` so a later
// column on the view — or on public.users, which it joins twice — cannot
// silently start reaching the counter.
const LIST_COLUMNS =
  'id, requisition_number, status, urgency, note, rejection_note, ' +
  'reviewed_by, reviewed_at, created_by, created_at, updated_at, ' +
  'created_by_name, reviewed_by_name, item_count, total_qty, ' +
  'estimated_total, unpriced_item_count, vendor_count';

const ITEM_COLUMNS =
  'id, requisition_id, medicine_id, qty, supplier_id, supplier_name, ' +
  'unit_cost, mrp, price_as_of, note, created_at';

// Exactly the six columns medicine_vendor_prices has, and no more. Named
// rather than '*' so that a column added to the view later — by someone who
// thinks it is obviously harmless — cannot reach a Staff session without a
// decision being made.
const VENDOR_PRICE_COLUMNS =
  'medicine_id, supplier_id, supplier_name, last_unit_cost, last_mrp, last_purchased_on';

// The low-stock picker's payload. Deliberately narrow: what ran out, how much
// is left, and what "low" means for it. No cost, no margin, no supplier.
const LOW_STOCK_COLUMNS =
  'id, name, generic_name, unit, total_stock, low_stock_threshold';

const MAX_ITEMS = 50;

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

/** A finite number, or null. `Number(null)` is 0 and 0 is finite, so a naive
 *  guard turns an ABSENT rate into a cost of zero. Same reasoning as
 *  finiteOrNull in Module 23. */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The single owner account, or null if there somehow isn't one. */
async function getOwnerId() {
  const { data } = await supabase
    .from('users').select('id').eq('role', 'owner').eq('is_active', true).limit(1).maybeSingle();
  return data?.id || null;
}

/**
 * Every field that leaves this service passes through here.
 *
 * Criterion A9 asks for owner-only data to be ABSENT FROM THE PAYLOAD, not
 * merely unrendered, and the QA checklist wants that verified against real
 * Staff-session responses. The older modules owe that debt
 * (docs/UI-GUIDELINES-IMPLEMENTATION.md §7); this one is written to the
 * standard from its first commit so it never has to be retrofitted.
 *
 * What Staff DO see is the point of the module, and is the second scoped A9
 * exception: the distributor's NAME, the RATE we last paid them, the MRP, and
 * HOW OLD that price is. You cannot choose the cheapest of three vendors
 * without seeing three prices.
 *
 * What Staff do not see is everything else about a supplier. There is no
 * phone, contact_person, email, gst_no, drug_license_no, credit_terms_days or
 * outstanding balance in a Staff payload, because none of those help CHOOSE a
 * vendor — they help RING one, which is the owner's job and happens after
 * approval. `supplier_phone` is not merely stripped here either: it is not
 * even SELECTED for a staff request (see itemSelect), so it never enters this
 * process on their behalf.
 */
function presentItem(item, actor) {
  const rate = finiteOrNull(item.unit_cost);
  const base = {
    id: item.id,
    medicine_id: item.medicine_id,
    medicine_name: item.medicines?.name || null,
    unit: item.medicines?.unit || null,
    qty: item.qty,
    supplier_id: item.supplier_id,
    supplier_name: item.supplier_name,
    unit_cost: rate,
    mrp: finiteOrNull(item.mrp),
    price_as_of: item.price_as_of,
    // Derived on read, never stored — the same rule stock and margins follow.
    line_total: rate === null ? null : rate * Number(item.qty),
    note: item.note,
  };

  if (actor.role !== 'owner') return base;
  return { ...base, supplier_phone: item.suppliers?.phone || null };
}

/**
 * The embed list for one requisition's lines.
 *
 * The supplier embed is added ONLY for an owner. Selecting it for a staff
 * request and then dropping it in presentItem would work, but it would put a
 * distributor's phone number into this process on a staff member's behalf and
 * leave one `...spread` between it and the wire. Not asking for it is the
 * version that cannot regress.
 */
function itemSelect(actor) {
  const base = `${ITEM_COLUMNS}, medicines:medicine_id (name, unit)`;
  return actor.role === 'owner' ? `${base}, suppliers:supplier_id (phone)` : base;
}

function presentRequisition(row, items, actor) {
  return { ...row, items: (items || []).map((i) => presentItem(i, actor)) };
}

/** Loads the bare record for a permission check or a status transition.
 *  Deliberately the TABLE, not the view: this is about who owns the row and
 *  what state it is in, and the aggregates would be dead weight. */
async function loadRequisition(id) {
  const { data, error } = await supabase
    .from('stock_requisitions')
    .select('id, requisition_number, status, urgency, created_by, reviewed_by, reviewed_at')
    .eq('id', id)
    .single();

  if (error || !data) throw new AppError('Stock request not found.', 404, 'REQUISITION_NOT_FOUND');
  return data;
}

// ────────────────────────────────────────────────
// READ
// ────────────────────────────────────────────────

async function listRequisitions(
  { status = null, urgency = null, page = 1, limit = 20 } = {},
  actor
) {
  const offset = (page - 1) * limit;

  let q = supabase
    .from('stock_requisitions_with_totals')
    .select(LIST_COLUMNS, { count: 'exact' })
    // Urgent first within a day, then newest first: the owner's queue should
    // open on the thing somebody is waiting at the counter for.
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Staff see their own requests and nothing else — scoped in the PAYLOAD, not
  // by a component that chooses not to render the others.
  if (actor.role !== 'owner') q = q.eq('created_by', actor.id);

  if (status)  q = q.eq('status', status);
  if (urgency) q = q.eq('urgency', urgency);

  const { data, error, count } = await q;
  if (error) throw new AppError('Failed to fetch stock requests.', 500, 'DB_ERROR');

  return {
    requisitions: data || [],
    pagination: { page, limit, total: count || 0, pages: Math.ceil((count || 0) / limit) },
  };
}

async function getRequisitionById(id, actor) {
  const { data: row, error } = await supabase
    .from('stock_requisitions_with_totals').select(LIST_COLUMNS).eq('id', id).single();

  if (error || !row) throw new AppError('Stock request not found.', 404, 'REQUISITION_NOT_FOUND');

  // The identical gap bills and customer returns both had: the list scoped
  // staff by created_by and the by-id read did not, so the only way to reach a
  // colleague's row was to ask for it by id — which is exactly what an IDOR is.
  assertCanAccess(row, actor, { label: 'stock request' });

  const { data: items, error: itemErr } = await supabase
    .from('stock_requisition_items')
    .select(itemSelect(actor))
    .eq('requisition_id', id)
    .order('created_at', { ascending: true });

  if (itemErr) throw new AppError('Failed to fetch the request lines.', 500, 'DB_ERROR');
  return presentRequisition(row, items, actor);
}

/**
 * The rates this pharmacy last paid, for the medicines named, cheapest first —
 * followed by every other active distributor, unpriced.
 *
 * BATCHED BY CONSTRUCTION. The alternative — one request per line — is N round
 * trips on a form where N is however many things ran out today, and this shape
 * is also what lets "add everything that's running low" seed the whole dialog
 * in a single call.
 *
 * THE ROSTER HALF IS NOT PADDING. Both sources behind medicine_vendor_prices
 * are empty on a database where PO receipt has never worked and no batch
 * records its supplier, which is the state this repo is in — so a dropdown
 * built from price history alone would be blank for every medicine in the
 * shop. Listing the distributors we know about, marked as having no rate on
 * record, is the difference between a feature and a blank select. It also
 * matches what was asked for: the lowest price "out of all vendors".
 *
 * `actor` is taken and unused for scoping ON PURPOSE. This is the one endpoint
 * where Staff see vendor rates, and the answer is identical for both roles.
 * The parameter stays in the signature so a later reader can see the decision
 * was made rather than forgotten.
 */
async function getVendorPrices(medicineIds, actor) { // eslint-disable-line no-unused-vars
  const [pricesRes, suppliersRes] = await Promise.all([
    supabase.from('medicine_vendor_prices')
      .select(VENDOR_PRICE_COLUMNS)
      .in('medicine_id', medicineIds),
    // Name and id only. This is the widest the supplier table ever gets on a
    // staff response, and it is deliberately not `*`.
    supabase.from('suppliers')
      .select('id, name')
      .eq('is_active', true)
      .order('name', { ascending: true }),
  ]);

  if (pricesRes.error) throw new AppError('Failed to look up vendor prices.', 500, 'DB_ERROR');
  if (suppliersRes.error) throw new AppError('Failed to look up distributors.', 500, 'DB_ERROR');

  const roster = suppliersRes.data || [];

  // Keyed by medicine so the client can index straight in. A medicine we have
  // never bought is present with the roster rather than absent — the dialog
  // has to tell "no rate on record" apart from "not fetched yet", and an
  // absent key cannot say which.
  const byMedicine = Object.fromEntries(medicineIds.map((id) => [id, []]));

  (pricesRes.data || []).forEach((row) => {
    if (!byMedicine[row.medicine_id]) return;
    byMedicine[row.medicine_id].push({
      supplier_id: row.supplier_id,
      supplier_name: row.supplier_name,
      last_unit_cost: finiteOrNull(row.last_unit_cost),
      last_mrp: finiteOrNull(row.last_mrp),
      last_purchased_on: row.last_purchased_on,
    });
  });

  medicineIds.forEach((id) => {
    const priced = byMedicine[id];
    // Cheapest first IS the recommendation, not a display preference: the
    // dialog pre-selects the first option.
    priced.sort((a, b) => (a.last_unit_cost - b.last_unit_cost)
      || a.supplier_name.localeCompare(b.supplier_name, 'en'));

    const seen = new Set(priced.map((p) => p.supplier_id));
    roster.forEach((s) => {
      if (seen.has(s.id)) return;
      priced.push({
        supplier_id: s.id,
        supplier_name: s.name,
        last_unit_cost: null,
        last_mrp: null,
        last_purchased_on: null,
      });
    });
  });

  return byMedicine;
}

/**
 * What is running low right now, for the dialog's "add from low stock" picker.
 *
 * A purpose-built read rather than a call to /medicines?stock=low, for two
 * reasons. That endpoint selects `*` from medicines_with_stock, which is far
 * wider than a picker needs; and /medicines/alerts/low-stock — the narrow one
 * that already exists — is authorize('owner'), so the people who actually
 * notice the shelf is empty cannot call it.
 *
 * Ordered by how empty it is, because that is the order somebody restocking
 * cares about. Capped: this fills a checkbox list, not a report.
 */
async function getLowStockCandidates({ limit = 100 } = {}) {
  const { data, error } = await supabase
    .from('medicines_with_stock')
    .select(LOW_STOCK_COLUMNS)
    .eq('is_active', true)
    .eq('is_low_stock', true)
    .order('total_stock', { ascending: true })
    .order('name', { ascending: true })
    .limit(limit);

  if (error) throw new AppError('Failed to fetch low-stock medicines.', 500, 'DB_ERROR');
  return data || [];
}

/** The owner dashboard's queue. Mirrors attendance's getTodayBoard(): the
 *  dashboard payload carries rows so the card has something to paint on first
 *  render, and the card refetches for itself after each decision. */
async function getPendingRequisitionBoard({ limit = 5 } = {}) {
  const { data, error, count } = await supabase
    .from('stock_requisitions_with_totals')
    .select(LIST_COLUMNS, { count: 'exact' })
    .eq('status', 'pending')
    .order('urgency', { ascending: true })     // 'normal' < 'urgent' — see below
    .order('created_at', { ascending: true })  // oldest first: a queue, not a feed
    .limit(limit);

  if (error) throw new AppError('Failed to fetch pending stock requests.', 500, 'DB_ERROR');

  const rows = data || [];
  // 'urgent' sorts AFTER 'normal' alphabetically, so the database order is
  // wrong for a queue by exactly one flip. Done here rather than with a CASE in
  // the view because the view is shared with the list page, which sorts by date.
  rows.sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency === 'urgent' ? -1 : 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  return {
    rows,
    summary: {
      pending: count || 0,
      urgent: rows.filter((r) => r.urgency === 'urgent').length,
    },
  };
}

/** The staff dashboard's "waiting on the owner" strip. */
async function getMyPendingRequisitions(staffId, { limit = 5 } = {}) {
  const { data, error } = await supabase
    .from('stock_requisitions_with_totals')
    .select(LIST_COLUMNS)
    .eq('created_by', staffId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new AppError('Failed to fetch your stock requests.', 500, 'DB_ERROR');
  return data || [];
}

// ────────────────────────────────────────────────
// WRITE
// ────────────────────────────────────────────────

/**
 * Turn the client's {medicine_id, qty, supplier_id?} lines into rows ready to
 * insert, with every name and every figure read FROM THE DATABASE.
 *
 * The client never sends supplier_name, unit_cost, mrp or price_as_of, and if
 * it does they are dropped on the floor here. This is "created_by always comes
 * from the JWT" applied to money: the entire credibility of the exported
 * document rests on the figures being ones this pharmacy actually paid, and a
 * price posted from a browser is a price anybody can choose. "₹1.00 from Laxmi
 * Pharma" in a document the owner then rings an order against is not a display
 * bug.
 *
 * There is deliberately no free-text vendor. The dropdown offers the whole
 * active roster, so a distributor that exists can always be named properly, and
 * two spellings of one distributor can never end up in two separate orders on
 * the export. A distributor that does not exist yet is a supplier record
 * somebody needs to create — which the owner can do, and which then benefits
 * every later request.
 *
 * Three queries regardless of line count.
 */
async function snapshotVendors(items) {
  const medicineIds = [...new Set(items.map((i) => i.medicine_id))];
  const supplierIds = [...new Set(items.map((i) => i.supplier_id).filter(Boolean))];

  const [medRes, priceRes, supRes] = await Promise.all([
    supabase.from('medicines').select('id, name, is_active').in('id', medicineIds),
    supabase.from('medicine_vendor_prices').select(VENDOR_PRICE_COLUMNS).in('medicine_id', medicineIds),
    supplierIds.length
      ? supabase.from('suppliers').select('id, name, is_active').in('id', supplierIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (medRes.error)   throw new AppError('Failed to read the catalogue.', 500, 'DB_ERROR');
  if (priceRes.error) throw new AppError('Failed to read vendor prices.', 500, 'DB_ERROR');
  if (supRes.error)   throw new AppError('Failed to read distributors.', 500, 'DB_ERROR');

  const byMedicine = new Map((medRes.data || []).map((m) => [m.id, m]));
  const bySupplier = new Map((supRes.data || []).map((s) => [s.id, s]));
  const byPair = new Map((priceRes.data || [])
    .map((p) => [`${p.medicine_id}:${p.supplier_id}`, p]));

  return items.map((item) => {
    const medicine = byMedicine.get(item.medicine_id);
    if (!medicine) {
      throw new AppError('One of those medicines is no longer in the catalogue.', 404, 'MEDICINE_NOT_FOUND');
    }
    if (!medicine.is_active) {
      throw new AppError(
        `${medicine.name} has been deactivated. Remove that line and send the request again.`,
        422, 'MEDICINE_INACTIVE'
      );
    }

    const row = {
      medicine_id: item.medicine_id,
      qty: item.qty,
      supplier_id: null,
      supplier_name: null,
      unit_cost: null,
      mrp: null,
      price_as_of: null,
      note: item.note?.trim() || null,
    };

    // No vendor chosen. A legitimate line, not an omission — a medicine nobody
    // has a distributor for is exactly the kind of thing worth telling the
    // owner about, and it lands in the export's trailing "Vendor not specified"
    // section where it reads as the outstanding item it is.
    if (!item.supplier_id) return row;

    const supplier = bySupplier.get(item.supplier_id);
    if (!supplier) throw new AppError('That distributor was not found.', 404, 'SUPPLIER_NOT_FOUND');
    if (!supplier.is_active) {
      throw new AppError(
        `${supplier.name} is deactivated. Pick another distributor for ${medicine.name}.`,
        422, 'SUPPLIER_INACTIVE'
      );
    }

    row.supplier_id = supplier.id;
    row.supplier_name = supplier.name;

    // A distributor we have never bought this medicine from is a perfectly good
    // choice — it just comes with no rate, and the constraint on the table says
    // a rate without a date is not allowed, so the three move together or not
    // at all.
    const price = byPair.get(`${item.medicine_id}:${item.supplier_id}`);
    if (price) {
      row.unit_cost = finiteOrNull(price.last_unit_cost);
      row.mrp = finiteOrNull(price.last_mrp);
      row.price_as_of = row.unit_cost === null ? null : price.last_purchased_on;
    }

    return row;
  });
}

async function createRequisition({ urgency = 'normal', note = null, items }, actor) {
  if (!items?.length) throw new AppError('At least one medicine is required.', 422, 'NO_ITEMS');
  if (items.length > MAX_ITEMS) {
    throw new AppError(`A request can hold at most ${MAX_ITEMS} lines.`, 422, 'TOO_MANY_ITEMS');
  }

  // Two lines for the same medicine collide on the unique constraint below.
  // Catching it here means the message names the medicine instead of quoting a
  // constraint, and it costs one pass over an array of at most fifty.
  const seen = new Set();
  items.forEach((i) => {
    if (seen.has(i.medicine_id)) {
      throw new AppError(
        'That request lists the same medicine twice. Combine the quantities into one line.',
        422, 'DUPLICATE_MEDICINE'
      );
    }
    seen.add(i.medicine_id);
  });

  const rows = await snapshotVendors(items);

  const { data: numData } = await supabase.rpc('next_requisition_number');
  const requisition_number = numData;

  const { data: req, error } = await supabase
    .from('stock_requisitions')
    .insert({
      requisition_number,
      urgency,
      note: note?.trim() || null,
      // Never from the request body. Same rule as every other created_by here.
      created_by: actor.id,
    })
    .select('id, requisition_number, status, urgency, created_by, created_at')
    .single();

  if (error) {
    const mapped = mapDbError(error);
    throw mapped || new AppError('Failed to raise the stock request.', 500, 'DB_ERROR');
  }

  const { error: itemErr } = await supabase
    .from('stock_requisition_items')
    .insert(rows.map((r) => ({ ...r, requisition_id: req.id })));

  if (itemErr) {
    // There is no atomic RPC here because nothing outside these two tables is
    // written — but a parent with no lines is still a record of nothing, so it
    // is removed. The cascade on requisition_id takes any partial insert with
    // it. This is the same rollback createPurchase does.
    await supabase.from('stock_requisitions').delete().eq('id', req.id);
    const mapped = mapDbError(itemErr, {
      duplicateMessage: 'That request lists the same medicine twice. Combine the quantities into one line.',
      duplicateCode: 'DUPLICATE_MEDICINE',
    });
    throw mapped || new AppError('Failed to add the request lines.', 500, 'DB_ERROR');
  }

  await logAudit(actor.id, 'stock_requisition_created', {
    requisitionId: req.id,
    requisitionNumber: req.requisition_number,
    lineCount: rows.length,
    urgency,
  });

  const ownerId = await getOwnerId();
  if (ownerId) {
    await createNotification({
      user_id: ownerId,
      type: 'STOCK_REQUISITION_RAISED',
      title: urgency === 'urgent'
        ? `Urgent stock request from ${actor.full_name}`
        : `Stock request from ${actor.full_name}`,
      message: `${req.requisition_number} — ${rows.length} ${rows.length === 1 ? 'medicine' : 'medicines'} to procure.`,
      metadata: {
        requisition_id: req.id,
        requisition_number: req.requisition_number,
        raised_by: actor.id,
        urgency,
        line_count: rows.length,
      },
    });
  }

  return getRequisitionById(req.id, actor);
}

/** Tells the person who raised a request what the owner decided. Fire and
 *  forget, like every other notification: a failed notify must never undo a
 *  decision that was actually made. */
async function notifyRaiser(requisition, kind, actor, extra = {}) {
  if (requisition.created_by === actor.id) return; // the owner raised it themselves
  await createNotification({
    user_id: requisition.created_by,
    type: kind === 'approved' ? 'STOCK_REQUISITION_APPROVED' : 'STOCK_REQUISITION_REJECTED',
    title: kind === 'approved'
      ? `${requisition.requisition_number} approved`
      : `${requisition.requisition_number} rejected`,
    message: kind === 'approved'
      ? 'The owner approved your stock request and is placing the order.'
      : `The owner rejected your stock request: ${extra.rejection_note}`,
    metadata: {
      requisition_id: requisition.id,
      requisition_number: requisition.requisition_number,
      reviewed_by: actor.id,
      ...extra,
    },
  });
}

/**
 * Approve. Marks the record approved and unlocks the download — and does
 * NOTHING ELSE. No purchase order, no batch, no ledger row. The owner places
 * the order from the exported document, and the goods come in through the
 * receiving path like every other delivery.
 */
async function approveRequisition(id, actor) {
  const requisition = await loadRequisition(id);
  if (requisition.status !== 'pending') {
    throw new AppError(
      `${requisition.requisition_number} has already been ${requisition.status}.`,
      409, 'INVALID_STATUS'
    );
  }

  const { error } = await supabase
    .from('stock_requisitions')
    .update({ status: 'approved', reviewed_by: actor.id, reviewed_at: new Date().toISOString() })
    .eq('id', id)
    // Re-assert the state we checked. Two owners approving at once would
    // otherwise both succeed, and the second would overwrite the first's
    // reviewer — cheap, and it costs one predicate.
    .eq('status', 'pending');

  if (error) throw new AppError('Failed to approve the stock request.', 500, 'DB_ERROR');

  await logAudit(actor.id, 'stock_requisition_approved', {
    requisitionId: id, requisitionNumber: requisition.requisition_number,
  });
  await notifyRaiser(requisition, 'approved', actor);

  return getRequisitionById(id, actor);
}

async function rejectRequisition(id, { rejection_note }, actor) {
  const requisition = await loadRequisition(id);
  if (requisition.status !== 'pending') {
    throw new AppError(
      `${requisition.requisition_number} has already been ${requisition.status}.`,
      409, 'INVALID_STATUS'
    );
  }

  const note = rejection_note.trim();
  const { error } = await supabase
    .from('stock_requisitions')
    .update({
      status: 'rejected',
      rejection_note: note,
      reviewed_by: actor.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending');

  if (error) throw new AppError('Failed to reject the stock request.', 500, 'DB_ERROR');

  await logAudit(actor.id, 'stock_requisition_rejected', {
    requisitionId: id, requisitionNumber: requisition.requisition_number, reason: note,
  });
  await notifyRaiser(requisition, 'rejected', actor, { rejection_note: note });

  return getRequisitionById(id, actor);
}

/**
 * Withdraw a request the owner has not decided yet.
 *
 * Deliberately NOT assertCanAccess: that lets owners through unconditionally,
 * and an owner cancelling somebody's request is a rejection wearing the wrong
 * word. A rejection carries a reason the staff member can act on; a
 * cancellation arrives with nothing. The 403 names the alternative rather than
 * simply refusing.
 */
async function cancelRequisition(id, actor) {
  const requisition = await loadRequisition(id);

  if (requisition.created_by !== actor.id) {
    throw new AppError(
      'Only the person who raised this request can withdraw it. Reject it instead, with a reason.',
      403, 'FORBIDDEN'
    );
  }
  if (requisition.status !== 'pending') {
    throw new AppError(
      'Only a request still waiting on the owner can be withdrawn.',
      409, 'INVALID_STATUS'
    );
  }

  const { error } = await supabase
    .from('stock_requisitions')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'pending');

  if (error) throw new AppError('Failed to withdraw the stock request.', 500, 'DB_ERROR');

  await logAudit(actor.id, 'stock_requisition_cancelled', {
    requisitionId: id, requisitionNumber: requisition.requisition_number,
  });

  return getRequisitionById(id, actor);
}

/**
 * Everything the export needs, and every reason it might refuse — all resolved
 * BEFORE the controller writes a single header.
 *
 * Once Content-Disposition and one chunk are on the wire, a throw can no
 * longer become a JSON 500; it becomes a truncated .xlsx that Excel refuses to
 * open and blames on the user. So the 404, the ownership check and the
 * "approved?" check all happen here, where errorHandler still owns the
 * response.
 */
async function getRequisitionForExport(id, actor) {
  const requisition = await getRequisitionById(id, actor);

  if (requisition.status !== 'approved') {
    throw new AppError(
      'Approve this request before downloading it.',
      409, 'NOT_APPROVED'
    );
  }
  return requisition;
}

module.exports = {
  listRequisitions,
  getRequisitionById,
  getVendorPrices,
  getLowStockCandidates,
  getPendingRequisitionBoard,
  getMyPendingRequisitions,
  createRequisition,
  approveRequisition,
  rejectRequisition,
  cancelRequisition,
  getRequisitionForExport,
  // exported for unit testing
  finiteOrNull,
  MAX_ITEMS,
};
