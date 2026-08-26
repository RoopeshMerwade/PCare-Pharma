# Module 27 — Loose Units (selling tablets out of an opened strip)

**Status:** implemented, not yet applied to any database.
**Migration:** `backend/src/db/schema-27-loose-units.sql` (step 15 in `MIGRATION-ORDER.md`)
**Files touched:** 23 (2 new backend modules, 1 new frontend module, 1 new migration, 3 new test suites, 14 modified, 2 docs)

---

## 1. What this adds, and the one thing it does not change

A customer asks for 2 tablets out of a 10-tablet strip. Before this module the answer was
"bill one whole strip" — `medicines.unit` counts strips, `inventory_ledger.change_qty` counts
strips, and there was no representation for eight tablets sitting behind the counter.

**`inventory_ledger` still counts sealed saleable units.** That is the single most important
sentence in this document. Billing, FEFO, purchases, supplier returns, reorder thresholds,
`total_stock` and `medicines.unit` all keep meaning exactly what they meant.

What is added is a **second, parallel append-only ledger** counted in *contents*
(tablets/capsules/pieces), plus exactly one transition that connects the two:

```
open a strip   inventory_ledger    -1   'strip_opened'
               loose_unit_ledger  +10   'strip_opened'

sell 2         loose_unit_ledger   -2   'sale'
```

An auditor reading both ledgers side by side sees: *100 strips received, one opened, two tablets
sold, eight tablets loose.* Every number is a `SUM` over immutable rows.

### 1.1 Why not simply count tablets

This was tried and reverted once already. `schema-24` multiplied incoming quantity by pack size;
`schema-25` undid it. The reasoning is recorded in `CLAUDE.md` and still holds:

> `pack_size` existed nowhere outside Module 23 — billing, FEFO, returns and adjustments all move
> `inventory_ledger.change_qty` in the unit named by `medicines.unit`. Multiplying at import posted
> a quantity in a *different denomination* into that shared ledger, so FEFO would then sell strips
> that never arrived. That is silent stock corruption, not a rounding error.

Converting the whole system to tablets would hit the same wall from the other side: a 100ML syrup
bottle and a 30GM ointment tube are **one saleable thing each**, and there is no honest tablet
count for them.

### 1.2 Why a ledger and not a `remaining_loose_quantity` column

A mutable counter on the batch would be:

- the only stock figure in this database that is **stored rather than computed**, breaking the rule
  the codebase applies to stock, margins, supplier balances and adherence status alike;
- the only one with **no history** explaining how it reached its value.

`prevent_negative_loose_stock` and `block_loose_ledger_update/delete` are exact mirrors of the
sealed ledger's triggers, so loose stock inherits the same guarantees rather than a weaker set.
The "OpenedStock" entity is the view `batch_loose_stock`.

### 1.3 Why one aggregate row per batch, not one per opened strip

Nothing in this domain identifies an individual strip. `inventory_batches` is the finest-grained
physical thing the system knows about, and **expiry** — the only reason loose stock must stay tied
to its origin — lives on the batch. Two half-strips of the same batch are indistinguishable on the
shelf and in law, so "eight loose tablets against batch A" is the whole truth.

---

## 2. Prerequisites — read before running the migration

Verified against the live Supabase project on 2026-08-23:

| Probe | Result |
|---|---|
| `supplier_invoice_items.printed_rate` (schema-24) | **missing** |
| `supplier_invoice_items.pack_recognised` (schema-25) | **missing** |
| `supplier_invoice_items.pack_size` (schema-25 *drops* it) | **still present** |
| `staff_attendance` (schema-26) | present |
| Supplier invoices in `NEEDS_REVIEW` | **3** |

**Two consequences:**

1. `commit_supplier_invoice()` on that database is still the schema-23 version, which multiplies
   stock by `pack_size`. Importing any of those 3 pending invoices would post 500 where the rest of
   the app means 5. **Apply schema-24 and schema-25 before importing anything.**
2. Section 27.12 of this migration replaces `commit_supplier_invoice()` with a version that reads
   `pack_recognised` / `content_quantity` / `content_unit`. PL/pgSQL does not resolve column
   references at `CREATE FUNCTION` time, so on a schema-23 database it would install cleanly and
   then fail at import time with an error naming a *record field* rather than a missing migration.

**Section 27.0 is a guard against exactly that.** It aborts with
`MIGRATION_OUT_OF_ORDER: schema-25-pack-contents.sql has not been applied` and a hint, changing
nothing.

Required order (schema-26 is independent and may already be applied):

```
schema-24-invoice-line-detail.sql    step 12
schema-25-pack-contents.sql          step 13   ← THE denomination fix
schema-27-loose-units.sql            step 15   ← this module
```

---

## 3. Database — `backend/src/db/schema-27-loose-units.sql`

Placed in `src/db/` rather than a module folder for the same reason as schema-22: it is
cross-cutting, touching medicines, inventory, billing, returns and supplier invoices, and it
replaces atomic RPCs.

| § | Change |
|---|---|
| 27.0 | Prerequisite guard — aborts if schema-25 is absent |
| 27.1 | `medicines` + `pack_content_quantity`, `pack_content_unit` |
| 27.2 | `inventory_batches` + `content_quantity`, `content_unit` |
| 27.3 | `is_countable_content(text)` function |
| 27.4 | `inventory_ledger` reason CHECK gains `'strip_opened'` |
| 27.5 | `loose_unit_ledger` table, indexes, RLS |
| 27.6 | `prevent_negative_loose_stock`, `block_loose_ledger_update/delete` |
| 27.7 | Views: `batch_loose_stock` (new); `batches_with_stock`, `medicines_with_stock`, `expiry_summary` rebuilt |
| 27.8 | `bill_items` + `is_loose`, `pack_content_quantity` |
| 27.9 | `margin_analytics` rebuilt — denomination-aware cost |
| 27.10 | `create_bill_atomic()` replaced |
| 27.11 | `approve_customer_return_atomic()` replaced |
| 27.12 | `commit_supplier_invoice()` replaced |

### 3.1 Pack contents — two levels, deliberately

```sql
medicines.pack_content_quantity   int      -- the standard pack: 10
medicines.pack_content_unit       text     -- TABLET | CAPSULE | PIECE | ML | GM | …
inventory_batches.content_quantity int     -- what THIS batch actually is
inventory_batches.content_unit     text
```

The batch wins where set; the catalogue is the fallback. This mirrors the
`default_selling_price` / `selling_price` pair the schema already uses. A run of 15s under a
product catalogued as 10s must open into fifteen tablets, not ten.

Where **neither** is set the batch cannot be split at all, and the trigger raises
`NOT_SPLITTABLE` rather than assuming a pack size — a guessed content quantity would put a wrong
number of tablets on the shelf with nothing downstream able to detect it.

Both columns carry CHECK constraints on the same vocabulary `parsePack()` produces
(`TABLET, CAPSULE, PIECE, MCG, MG, KG, GM, ML, L, DOSE, IU`) and `> 0` on the quantity.

### 3.2 Countability — the rule the module rests on

```sql
create or replace function public.is_countable_content(p_unit text)
returns boolean language sql immutable
as $$ select p_unit in ('TABLET', 'CAPSULE', 'PIECE') $$;
```

Only these three describe **discrete objects inside the pack**. `100ML`, `30GM`, `120MD` are
measured contents of one sealed container. The suffix carries the whole meaning — `100'S`,
`100ML`, `100GM` and `100MD` share a digit and describe four different things — which is the same
rule Module 23's `parsePack()` enforces at ingest.

`content_quantity` must also exceed 1: a pack of one is already its own smallest unit, and
"opening" it would create a second denomination for a single physical object.

This rule now exists in three places and **they must stay in step**:

| Layer | Location |
|---|---|
| Database | `is_countable_content()` |
| Backend | `isCountableContent()` in `billing/fefo.js` |
| Frontend | `isCountableContent()` in `domain/pack.js` |

### 3.3 The loose ledger

```sql
create table public.loose_unit_ledger (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references public.inventory_batches(id),
  change_qty  int  not null check (change_qty <> 0),   -- content units
  reason      text not null check (reason in
                ('strip_opened','sale','return_inward','adjustment','expiry_writeoff')),
  ref_id      uuid,
  note        text,
  created_by  uuid references public.users(id),
  created_at  timestamptz not null default now()
);
```

The reason list is deliberately **shorter** than the sealed ledger's:

- no `purchase_receipt` — loose stock is never delivered by a distributor;
- no `return_outward` — a debit note covers sealed goods;
- no `opening_stock` — a go-live loose balance is an `adjustment`, which forces the explanatory note.

Indexes: `batch_id`, `created_at desc`, `reason`, and a covering
`(batch_id) include (change_qty)` for the balance read on every loose sale.

RLS mirrors `inventory_ledger`: authenticated select/insert, **no update or delete policy**.

### 3.4 Trigger guards

`check_no_negative_loose_stock()` does three things:

1. **Takes `FOR UPDATE` on the batch row.** This is an addition over the sealed trigger, which
   relies on callers locking first. Locking inside the trigger makes the check self-contained —
   a caller that already holds the lock re-locks its own row for free, a caller that forgot is
   serialised anyway. Two tills selling the last four loose tablets can no longer both pass.
2. **Refuses positive movements on a non-splittable batch** (`NOT_SPLITTABLE`).
3. **Refuses a movement that would take the balance below zero** (`INSUFFICIENT_LOOSE_STOCK`).

Guard 2 applies to **positive movements only**, and that asymmetry is intentional: taking loose
units *out* — selling, writing off, correcting a miscount — must stay possible even if the pack
description is later changed or cleared, or that stock is stranded (unsellable, unwritable-off,
and still on the books). Creating loose units still requires a description.

### 3.5 Views

`batches_with_stock`, `medicines_with_stock` and `expiry_summary` are **dropped and recreated**,
not replaced. They select `b.*` / `m.*` / `bws.*`, §27.1–27.2 add columns mid-expansion, and
`CREATE OR REPLACE VIEW` can only append columns. `expiry_summary` depends on
`batches_with_stock`, so the drops run in dependency order. No `CASCADE` — an unknown dependency
should fail loudly.

**New — `batch_loose_stock`** (the "OpenedStock" entity):

```
batch_id, loose_qty, first_opened_at, last_movement_at, units_ever_opened
```

**`batches_with_stock`** gains `sealed_qty`, `loose_qty`, `effective_content_quantity`,
`effective_content_unit`, `loose_sale_supported`. `stock_qty` keeps its exact old name and
meaning. Both balances use **scalar subqueries**, not joins — joining both ledgers and grouping
would multiply each ledger's rows by the other's and inflate both sums.

**`medicines_with_stock`** gains `total_loose_stock`, `loose_sale_supported`. `total_stock` still
counts sealed units only: it feeds `is_low_stock`, reorder thresholds and every "12 strips" label
in the app, and folding part-strips in would change what all of those mean.

Both booleans are wrapped in `coalesce(..., false)` — `true AND NULL` is `NULL` in SQL, and an
unrecorded quantity beside a countable unit would otherwise answer "don't know" to a yes/no
question.

**`expiry_summary`** now admits batches holding only loose stock
(`where stock_qty > 0 or loose_qty > 0`) and includes them in `potential_loss_value` at their
share of unit cost.

### 3.6 Bill lines carry their denomination

```sql
bill_items.is_loose              boolean not null default false
bill_items.pack_content_quantity int
```

`qty` has always meant "saleable units". A loose line means tablets, and the two cannot share a
column without a flag saying which — that is precisely the mistake schema-25 had to undo one layer
down. **Never infer `is_loose` from the quantity.** Defaulting to `false` is what makes the
migration invisible to every historical row.

`pack_content_quantity` is a snapshot in the same spirit as `unit_price` and `mrp`: re-cataloguing
a pack later must not retroactively change what an old bill's margin was.

### 3.7 `margin_analytics` — the bug this prevents

`inventory_batches.unit_cost` is the cost of a whole strip; a loose line's `unit_price` is the
price of one tablet. Comparing them directly reports a **ruinous negative margin on every split
sale**. The rebuilt view divides cost by the same pack it divided price by:

```sql
cross join lateral (
  select case
    when bi.is_loose and coalesce(bi.pack_content_quantity, 0) > 0
      then ib.unit_cost::numeric / bi.pack_content_quantity
    else ib.unit_cost::numeric
  end as effective_cost
) c
```

### 3.8 `create_bill_atomic()`

Item entries now take one of two shapes, both FEFO-resolved by the API:

```
sealed  {medicine_id, batch_id, qty, unit_price, mrp}
loose   {medicine_id, batch_id, qty, unit_price, mrp, is_loose: true,
         content_quantity, strips_to_open}
```

Absent `is_loose`, behaviour is byte-for-byte as before.

Write order inside the transaction:

1. Lock every touched batch `FOR UPDATE` (unchanged — this also covers loose lines, since loose
   stock is keyed by `batch_id`, so the batch row is the one mutex both denominations queue behind).
2. Insert bill, then all bill items.
3. Sealed `'sale'` ledger rows, set-based (unchanged).
4. Loop loose lines: **open the strips first**, then post the loose sale.

Step 4's ordering is physical, not stylistic. Inverting it would trip
`prevent_negative_loose_stock` on a batch with no prior loose balance — correctly, since selling a
tablet you have not yet freed is not something that can happen at a counter either.

`strips_to_open` is computed by the allocator against a stock read that may already be stale. That
is safe for the same reason the existing sealed path is safe: both triggers re-check against the
locked, committed balance, so a stale figure can only abort the whole transaction — never post a
wrong one.

### 3.9 `approve_customer_return_atomic()`

Which ledger a returned line goes back to is **not** a new field on the return — it is
`bill_items.is_loose`, joined through the `bill_item_id` the return already carries. A
denormalised copy could disagree with the line it describes; a join cannot.

Loose tablets come back as loose tablets. There is no path from here to a sealed strip, because an
opened strip cannot be re-sealed — restoring one would invent a saleable unit that is not on the
shelf.

### 3.10 `commit_supplier_invoice()`

Module 23 has parsed `"10'S"` into `10 PIECE` since schema-25; it just had nowhere to put the
answer. Two changes:

- the batch insert carries `content_quantity` / `content_unit`, but **only where
  `pack_recognised` is true** — an unparsed pack stays null and the batch simply cannot be split,
  which is the right answer rather than a degraded one;
- a blank on the catalogue is filled from the invoice, and a curated value is **never** overwritten
  (the owner's entry is a decision; this is an inference from one invoice).

`v_units` is untouched: stock in is still `qty_billed + qty_free`, in saleable units.

---

## 4. Backend

### 4.1 New — `src/utils/money.js`

`roundPaise` and `finiteOrNull` moved here from `supplier-invoices.normalize.js`, which now
imports and **re-exports both**, leaving Module 23's public surface and test suite unchanged.

Loose pricing divides a strip price by its tablet count and needs the identical rounding. Two
rounding rules in one codebase is how a ₹0.01 disagreement between a bill and a margin report
starts.

Half-up is deliberate in both directions: for a cost, rounding a tie down understates what stock
cost and overstates every margin from it; for a loose selling price, a ₹10.00 strip of 7 is ₹1.43
a tablet, so seven sold singly fetch ₹10.01 rather than ₹9.99.

### 4.2 New — `src/config/capabilities.js`

**This module is load-bearing, not defensive dressing.**

Selecting a column PostgREST does not know fails the *whole* query. When `/medicines/search`
returns an error, `useMedicineSearch` catches it into `[]` — so a pending migration silently
emptied the medicine dropdown and **no bill could be started at all**. That regression was
introduced and fixed during this work; see §8.

`hasLooseUnits()` probes `loose_sale_supported` once per process and memoises **the promise**, so
a burst of concurrent searches at startup issues one probe between them. It fails closed: anything
unexpected is treated as "not available", because running without the loose columns is a working
POS and guessing wrong the other way is a broken one.

The probe caches, so **the API must be restarted after applying the migration.**

### 4.3 `src/modules/billing/fefo.js`

New exports alongside the untouched `allocateFefo` and `partitionWarnings`:

| Function | Purpose |
|---|---|
| `isCountableContent(unit)` | the splittability rule |
| `perUnitPrice(price, contents)` | half-up per-unit price, floored at ₹0.01 |
| `allocateCartLine(batches, {qty, looseQty})` | the entry point — both denominations, one pool |
| `allocateLooseFromPool(pool, qty)` | loose FEFO; mutates the pool |
| `looseAvailable(batches)` | advisory total for messages |
| `supportsLooseSale(batches)` | separates "not sold loose" from "not enough" |

`mergeCartItems` now sums `loose_qty` alongside `qty` and **omits the key entirely when zero**, so
a cart that never mentions loose units produces the exact object shape it always did.

`perUnitPrice` is floored at ₹0.01 because `bill_items.unit_price` and `.mrp` both carry
`check (> 0)`: a ₹0.50 pack of 100 would otherwise derive zero and abort the sale at the database
rather than at the counter.

#### The allocation algorithm

`allocateCartLine` builds one mutable pool from the FEFO batch list, then:

**Pass 1 — sealed.** Delegates to the existing `allocateFefo` (genuine reuse, not a copy), then
applies its consumption back to the shared pool.

**Pass 2 — loose.** Per batch in expiry order:

1. Consume tablets **already loose** in this batch. An opened pack is the most perishable stock in
   the shop — its foil is broken — so it is spent before anything else is disturbed.
2. If still short, open the **minimum**: `min(ceil(remaining / contents), sealed)`.
3. Whatever the opened pack does not sell stays loose **against this batch**, which is what keeps
   it tied to this expiry date.
4. Move on only when this batch is exhausted in **both** pools.

Sealed goes first, deliberately. When one pack is left and the line wants both a whole pack and a
tablet, the whole pack wins: `qty` is a request for intact goods, and satisfying it by opening the
pack and counting out ten tablets would hand the customer something different from what was rung
up. Neither ordering can satisfy both, so the one that reports the shortfall on the half that can
be filled another way is the useful one.

#### Worked example

```
Batch A  exp Jan 2027   sealed 10   loose 4
Batch B  exp Jun 2027   sealed 20   loose 0

Customer buys 6 tablets:
  4 from A's existing loose        → remaining 2
  open 1 sealed pack of A (+10)    → sell 2, keep 8

Result:  A sealed 9, loose 8.   B untouched.
```

### 4.4 `src/modules/billing/billing.service.js`

`createBill` now resolves both denominations per cart line and raises three distinct errors:

| Condition | Response |
|---|---|
| loose asked for, no splittable batch | `422 LOOSE_SALE_UNSUPPORTED` |
| sealed shortfall | `409 INSUFFICIENT_STOCK` *(unchanged)* |
| loose shortfall | `409 INSUFFICIENT_LOOSE_STOCK` |

### 4.5 `src/modules/billing/billing.routes.js`

`items.*.qty` floor drops from `1` to `0`, `items.*.loose_qty` added as optional
`isInt({min: 0})`, and a custom validator rejects a line that is zero in **both** — "3 tablets and
no whole strip" is a complete instruction; "0 and 0" is the empty line this always caught.

### 4.6 `src/modules/inventory/inventory.service.js`

- `VALID_REASONS` gains `'strip_opened'`; new `VALID_LOOSE_REASONS`.
- `getAvailableBatchesFEFO` selects the loose columns and matches
  `stock_qty > 0 OR loose_qty > 0` — a batch whose last pack is open holds no sealed units but may
  still have eight tablets, and dropping it would hide sellable stock *and* break FEFO for the
  loose pool, since it is the nearest-expiry batch. Both the columns and the OR are gated on
  `hasLooseUnits()`.
- `addBatch` accepts `content_quantity` / `content_unit`.
- **New** `appendLooseLedger()` — the loose twin of `appendLedger`, mapping `NOT_SPLITTABLE` and
  `INSUFFICIENT_LOOSE_STOCK`.
- `adjustStock` accepts `denomination: 'sealed' | 'loose'`, defaulting to `sealed`.
- `writeOffExpiredBatch` clears **both** pools. Loose tablets expire with the pack they came from;
  leaving them would strand stock that is unsellable, invisible to the sealed write-off, and still
  counted as an asset.
- **New** `getLooseMovements(batchId)` — kept separate from `getLedgerMovements` rather than
  unioned, because that endpoint embeds `inventory_batches` and `users` through PostgREST foreign
  keys, which a UNION view has none of. The sealed side of every opening already appears there as a
  `strip_opened` row. *(Currently has no caller.)*

### 4.7 `src/modules/medicines/`

- `CONTENT_UNITS` constant, exported for route validation.
- `createMedicine` / `updateMedicine` accept the pack pair, stored **all-or-nothing**: a
  half-filled answer is stored as no answer, because a countable pack of unknown size is exactly
  what would let a strip be split into an invented number of tablets.
- `searchMedicines` returns the pack columns so the POS needs no second request per result — gated
  on `hasLooseUnits()`.
- `updateMedicine` refuses to re-describe a pack while any batch holds loose stock
  (`409 LOOSE_STOCK_OPEN`). Eight tablets counted against a strip of 10 become eight-tenths of a
  strip of 15 the moment the number changes: same row, different meaning, and every derived price
  moves with it.
- Route validation: `pack_content_quantity` 1–1000 (a typo guard — the number *divides a price*,
  so a slipped zero makes every tablet a tenth of its real value), `pack_content_unit` in
  `CONTENT_UNITS`.

### 4.8 `src/utils/dbErrors.js`

`INSUFFICIENT_LOOSE_STOCK` → 409, `NOT_SPLITTABLE` → 422. Both are raised by the loose trigger
inside `create_bill_atomic`; reaching them means the API's own check was raced, and the whole bill
rolls back.

---

## 5. Frontend

### 5.1 New — `src/domain/pack.js`

`domain/`, not `components/`: "can this be split", "what is one tablet worth" and "how do I say
24 strips + 6 tablets" are pharmacy meaning, and the billing screen, inventory drawer and
inventory list all have to agree.

Mirrored from `billing/fefo.js` **on purpose** — the same arrangement `domain/invoice.js` has with
Module 23's normaliser. The cashier must watch the total update as they type into the Tablets box,
and a round-trip per keystroke would make the field feel broken. **The server remains
authoritative**; nothing here allocates stock, picks a batch or decides what a sale costs.

Exports: `COUNTABLE_CONTENT_UNITS`, `isCountableContent`, `supportsLooseSale`, `packContents`,
`perUnitPrice`, `contentNoun`, `sealedNoun`, `packLabel`, `availabilityLabel`, `looseAvailable`,
`lineTotals`, `wholePackHint`.

`supportsLooseSale` prefers the server's `loose_sale_supported` and falls back to the local test —
the pattern `stockStatus()` already uses for `is_low_stock`, and what makes the UI degrade cleanly
before the migration.

`availabilityLabel` deliberately never returns one number: 24 strips and 6 tablets is not
"24.6 strips" and not "246 tablets". They are physically different things.

### 5.2 `src/components/billing/BillingPage.jsx`

A splittable line renders two boxes; everything else renders the single box it always had.

```
Dolo 650                                    [ Strips ]  [ Tablets ]
₹18.00 per strip · ₹1.20 per tablet ·           2           3
5 strips in stock
15 tablets per strip                                        ₹39.60
Dispensing 2 strips + 3 tablets · 33 units in total
```

- New module-scope `cartLine()` builds a cart row in one place, so *add* and *swap* cannot drift on
  which fields they carry — the pack columns are exactly what the second copy would have forgotten.
- Swapping to a non-splittable substitute drops the loose count, rather than leaving "3 tablets"
  attached to a bottle for the server to reject at submit.
- `blockingReason` gains a loose-availability check that subtracts the whole packs already
  committed on the same line, matching how the server resolves the two halves against one pool.
- Payload omits `loose_qty` when zero.
- The receipt prints the denomination — "Crocin × 2" meaning two tablets and meaning two strips is a
  five-fold difference in what was handed over, and that is the last screen anyone checks.
- Visible labels are one word so two boxes fit side by side; `aria-label` carries the medicine
  name, since "Strips" repeated down a cart tells a screen-reader user nothing. The accessible name
  still contains the visible text (WCAG 2.5.3).

### 5.3 `src/components/medicines/MedicineModal.jsx`

A **Pack contents** fieldset. The unit dropdown is split into two labelled groups —
*Countable — can be sold singly* and *Measured — sold whole only* — so the consequence is visible
at the point of choosing, and a live confirmation line states it in the same words the billing
screen will use.

Validation refuses a half-filled pair (matching the server's all-or-nothing storage) and refuses a
countable pack of 1.

### 5.4 `src/components/inventory/BatchDrawer.jsx`

Per-batch `+ 8 tablets loose` under the sealed count, a per-tablet price row for splittable
batches only, and `hasStock` now counts loose — otherwise a batch showing "0 strips" reads as empty
while eight tablets sit on the shelf, and the **Write off** button, gated on having something to
write off, would never appear for them. The medicine-level header shows the loose total too.

### 5.5 `src/components/inventory/InventoryPage.jsx`

Loose units on a second line under **On hand**, never added into it.

---

## 6. Tests

| Suite | Tests | Runs without credentials |
|---|---|---|
| `backend/tests/unit/loose-units.test.js` | **41** | ✅ |
| `frontend/src/domain/pack.test.js` | **36** | ✅ |
| `backend/tests/loose-units.test.js` | 19 cases | ❌ needs `TEST_*` + migrated DB |

The two unit suites are deliberate mirrors of each other, asserting the same arithmetic on both
sides so the counter cannot quote a figure the server disagrees with.

Covered: countability for all eleven content units; half-up rounding and the ₹0.01 floor; merge
behaviour and its backward-compatible object shape; all edge cases (open one pack; consume existing
loose without opening; loose-then-open; the *minimum* packs opened for 25 units; no stock;
partial shortfall); FEFO across batches including "do not touch batch B"; per-batch loose pools;
sealed-only, loose-only and mixed lines; the shared-pool contention case; non-countable packs
refused for splitting but still sellable whole; pool mutation.

**The integration suite has never executed.** It covers ledger reconciliation, trigger refusals,
return routing and the two concurrency cases. The concurrency guarantee (`FOR UPDATE` on the batch
row plus the trigger's own re-lock) is **reasoned, not measured**.

### Verification actually performed

| Check | Result |
|---|---|
| `backend: npx jest tests/unit` | 153 passed = 112 pre-existing (untouched, incl. the original `fefo.test.js`) + 41 new |
| `backend: jest` incl. hermetic invoice suites | 179 passed, 8 suites |
| `frontend: npm run check` | lint 0 errors · 214 tests · build clean |
| Migration SQL parsed (libpg-query) | 47 statements OK |
| Migration PL/pgSQL parsed | 8 function bodies OK |
| `npm run postman:check` | up to date, 121 requests documented |
| Live DB smoke (pre-migration) | search 14 results, FEFO 1 sellable batch |

Syntax validation is **not** semantic validation: it does not prove a column reference resolves.

---

## 7. API changes

**No new routes.** The Postman collection stays at 121 requests; descriptions and example bodies
were updated in `tools/postman/routes-meta.js` and the collection regenerated.

```jsonc
// POST /api/v1/billing
{ "items": [ { "medicine_id": "…", "qty": 2, "loose_qty": 3 } ] }

// POST /api/v1/medicines,  PATCH /api/v1/medicines/:id
{ "pack_content_quantity": 10, "pack_content_unit": "TABLET" }

// POST /api/v1/inventory/batches
{ "content_quantity": 10, "content_unit": "TABLET" }

// POST /api/v1/inventory/adjust
{ "denomination": "loose" }
```

New error codes: `LOOSE_SALE_UNSUPPORTED` (422), `INSUFFICIENT_LOOSE_STOCK` (409),
`NOT_SPLITTABLE` (422), `LOOSE_STOCK_OPEN` (409).

---

## 8. Backward compatibility

- `inventory_ledger` never changed denomination.
- `bill_items.is_loose` defaults to `false` — what every historical row is.
- `loose_qty` is optional, and `mergeCartItems` omits the key when zero, so an existing client's
  request body is byte-identical.
- `total_stock` still counts sealed units only.
- A catalogue with no pack contents recorded has **no splittable medicine**, so the app behaves
  exactly as before.
- `hasLooseUnits()` means the API runs correctly on an **un-migrated** database.

### A regression that occurred during this work

The first implementation selected the new columns unconditionally. On the un-migrated live
database PostgREST answered `42703`, `searchMedicines` threw, `useMedicineSearch` swallowed it into
`[]`, and **the medicine dropdown silently returned nothing — no bill could be started.**

Fixed by `capabilities.js`. The rule it encodes is the one `CLAUDE.md` already applies to
`GEMINI_API_KEY`: *the POS has to work in a pharmacy that never set the optional thing up.* A
pending migration may cost the loose-unit feature; it must never cost the till.

**Never reference a Module 27 column from a hot path without gating it.**

---

## 9. Known gaps

- **Never run against a migrated database** (§6).
- **`getLooseMovements()` has no caller** — written for a BatchDrawer history panel that does not
  exist yet.
- **Loose stock is not on the Reports screens.** `margin_analytics` handles it correctly, but no
  report separates loose from sealed revenue.
- **`receive_purchase_atomic` does not carry pack contents.** Untouched here — it is already broken
  by a pre-existing arity mismatch (see `CLAUDE.md`). Batches received that way need
  `content_quantity` set manually or inherit the medicine's.
- **No bulk way to set pack contents** across an existing catalogue; it is per-medicine in the form,
  or filled automatically by a Module 23 import.
- **Loose returns depend on the batch still being splittable.** If pack contents were cleared after
  the sale, the return is refused rather than posted into a denomination nobody can describe. The
  `LOOSE_STOCK_OPEN` guard makes this hard to reach.

### A deliberate decision worth re-reading before changing

**`loose_qty` equal to a full pack is accepted, not normalised into a sealed unit.** Rewriting
"10 tablets" to "1 strip" would fail a sale the shop can actually fill — when the batch already
holds 10 loose and 0 sealed. The allocator opens the minimum instead (for an exact multiple this is
physically identical to selling a strip), and the UI shows an advisory hint. The alternative was
considered and rejected for that reason.

---

## 10. Operator runbook

1. Apply `schema-24-invoice-line-detail.sql`, then `schema-25-pack-contents.sql`.
   *(Until this is done, importing a supplier invoice multiplies stock by pack size.)*
2. Apply `schema-27-loose-units.sql`. It aborts harmlessly if step 1 was skipped.
3. **Restart the backend** — the capability probe caches per process.
4. Edit a medicine → **Pack contents** → e.g. `15` + `tablets` → Save.
5. That medicine's billing line now shows **Strips** and **Tablets**.

To verify end to end: sell 2 tablets of a 15-per-strip medicine, then check the batch — sealed
should fall by 1 and loose should read 13, with a `strip_opened` row in `inventory_ledger` and
`+15` / `-2` in `loose_unit_ledger`.

---

## 11. File manifest

**New (6)**

```
backend/src/db/schema-27-loose-units.sql
backend/src/utils/money.js
backend/src/config/capabilities.js
backend/tests/unit/loose-units.test.js
backend/tests/loose-units.test.js
frontend/src/domain/pack.js
frontend/src/domain/pack.test.js
```

**Modified — backend (10)**

```
backend/src/modules/billing/fefo.js
backend/src/modules/billing/billing.service.js
backend/src/modules/billing/billing.routes.js
backend/src/modules/inventory/inventory.service.js
backend/src/modules/inventory/inventory.routes.js
backend/src/modules/medicines/medicines.service.js
backend/src/modules/medicines/medicines.routes.js
backend/src/modules/supplier-invoices/supplier-invoices.normalize.js
backend/src/utils/dbErrors.js
backend/tools/postman/routes-meta.js
```

**Modified — frontend (4)**

```
frontend/src/components/billing/BillingPage.jsx
frontend/src/components/medicines/MedicineModal.jsx
frontend/src/components/inventory/BatchDrawer.jsx
frontend/src/components/inventory/InventoryPage.jsx
```

**Modified — docs / generated (3)**

```
CLAUDE.md                                  (Module 27 section + known-incomplete entries)
docs/MIGRATION-ORDER.md                    (step 15)
docs/api/PCare-Pharma.postman_collection.json   (regenerated — never hand-edit)
```
