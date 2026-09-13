-- ============================================================================
-- schema-31 — live drift, committed back
-- ============================================================================
--
-- This file creates nothing new. It records changes that existed on the live
-- project (sttizzqvsgjpmrwwgpvw) and were made by NO file in this repository —
-- they were applied out-of-band through the SQL editor:
--
--   · purchases.invoice_no
--   · receive_purchase_atomic(uuid, uuid, jsonb, text)
--   · purchases_with_totals, rebuilt to carry p.invoice_no (PurchasesPage
--     renders po.invoice_no from it)
--   · supplier_balances, which that rebuild silently dropped — RESTORED here,
--     deliberately not reproduced (see the note above the views)
--   · row level security switched ON for chronic_conditions
--
-- Found by diffing a catalogue fingerprint of the live project against a
-- replay of files 1–30 onto an empty one, 2026-09-13. The function body and
-- the view body are pg_get_functiondef() / pg_get_viewdef() of the live
-- objects, verbatim.
--
-- Why it is numbered 31 and runs right after schema-30: schema-34 revokes and
-- grants on the 4-arg signature, and schema-35 drops the 3-arg one that
-- schema-22 creates. Replaying the repository without this file aborts at
-- schema-34 with 42883 (function does not exist). With it, 32 → 37 run clean.
--
-- While both overloads exist (between this file and schema-35) a 3-argument
-- call is ambiguous. Nothing calls the RPC during a migration, and schema-35
-- removes the 3-arg version.
--
-- Safe to re-run: `add column if not exists`, `create or replace`, the view is
-- dropped before it is created, and enabling RLS twice is a no-op.
-- ============================================================================

alter table public.purchases add column if not exists invoice_no text;

CREATE OR REPLACE FUNCTION public.receive_purchase_atomic(p_purchase_id uuid, p_user_id uuid, p_items jsonb, p_invoice_no text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_po public.purchases%rowtype;
  v_item jsonb;
  v_po_item public.purchase_items%rowtype;
  v_batch_id uuid;
  v_mrp numeric;
  v_sp numeric;
BEGIN
  SELECT * INTO v_po FROM public.purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  IF v_po.status <> 'sent' THEN
    RAISE EXCEPTION 'INVALID_STATUS: only sent orders can be received';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'NO_ITEMS: receipt items are required';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_po_item FROM public.purchase_items
     WHERE id = (v_item->>'purchase_item_id')::uuid AND purchase_id = p_purchase_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_NOT_FOUND: purchase item % not on this order', v_item->>'purchase_item_id';
    END IF;

    v_sp  := coalesce(nullif(v_item->>'selling_price', '')::numeric, v_po_item.unit_cost);
    v_mrp := coalesce(nullif(v_item->>'mrp', '')::numeric, v_sp);
    IF v_sp > v_mrp THEN
      RAISE EXCEPTION 'PRICE_EXCEEDS_MRP: selling price cannot exceed MRP';
    END IF;

    INSERT INTO public.inventory_batches
      (medicine_id, batch_no, exp_date, mfg_date, unit_cost, mrp, selling_price,
       supplier_id, po_id, created_by)
    VALUES
      (v_po_item.medicine_id,
       upper(trim(v_item->>'batch_no')),
       (v_item->>'exp_date')::date,
       nullif(v_item->>'mfg_date', '')::date,
       v_po_item.unit_cost, v_mrp, v_sp,
       v_po.supplier_id, p_purchase_id, p_user_id)
    RETURNING id INTO v_batch_id;

    INSERT INTO public.inventory_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
    VALUES (v_batch_id, (v_item->>'qty_received')::int, 'purchase_receipt',
            p_purchase_id, 'PO: ' || v_po.purchase_number || CASE WHEN p_invoice_no IS NOT NULL AND trim(p_invoice_no) <> '' THEN ' (Inv: ' || trim(p_invoice_no) || ')' ELSE '' END, p_user_id);

    UPDATE public.purchase_items
       SET qty_received  = (v_item->>'qty_received')::int,
           batch_no      = upper(trim(v_item->>'batch_no')),
           batch_id      = v_batch_id,
           mrp           = v_mrp,
           selling_price = v_sp,
           exp_date      = (v_item->>'exp_date')::date,
           mfg_date      = nullif(v_item->>'mfg_date', '')::date
     WHERE id = v_po_item.id;
  END LOOP;

  UPDATE public.purchases
     SET status = 'received',
         received_at = now(),
         received_by = p_user_id,
         invoice_no = nullif(trim(p_invoice_no), '')
   WHERE id = p_purchase_id;
END; $function$
;

-- The live view lists invoice_no third, right after purchase_number. CREATE OR
-- REPLACE VIEW may only append columns, so this is drop + create.
--
-- supplier_balances reads purchases_with_totals, so Postgres refuses that drop
-- without CASCADE. Live was most likely rebuilt WITH cascade: supplier_balances
-- is missing there and nothing recreated it. The loss is silent because
-- suppliers.service.js treats the balance merge as best-effort, so every
-- supplier shows 0 outstanding. It is dropped and recreated here, unchanged
-- from schema-06-10, so a replay restores the balances instead of repeating the
-- accident. The revokes restate schema-29 for both new objects, the same way
-- schema-30 and schema-36 carry their own.
drop view if exists public.supplier_balances;
drop view if exists public.purchases_with_totals;
create view public.purchases_with_totals as
 SELECT p.id,
    p.purchase_number,
    p.invoice_no,
    p.supplier_id,
    p.status,
    p.expected_delivery_date,
    p.notes,
    p.received_at,
    p.received_by,
    p.created_by,
    p.created_at,
    p.updated_at,
    s.name AS supplier_name,
    s.phone AS supplier_phone,
    s.credit_terms_days,
    COALESCE(sum(((pi.qty_ordered)::numeric * pi.unit_cost)), (0)::numeric) AS ordered_total,
    COALESCE(sum(((pi.qty_received)::numeric * pi.unit_cost)), (0)::numeric) AS received_total,
    count(pi.id) AS item_count
   FROM ((purchases p
     JOIN suppliers s ON ((s.id = p.supplier_id)))
     LEFT JOIN purchase_items pi ON ((pi.purchase_id = p.id)))
  GROUP BY p.id, s.id;

create view public.supplier_balances as
select
  s.id as supplier_id,
  s.name as supplier_name,
  s.credit_terms_days,
  coalesce(sum(p.received_total), 0) as total_purchased,
  0::numeric as total_paid   -- payment module will populate this
from public.suppliers s
left join public.purchases_with_totals p on p.supplier_id = s.id
  and p.status = 'received'
group by s.id, s.name, s.credit_terms_days;

revoke all on public.purchases_with_totals from anon, authenticated;
revoke all on public.supplier_balances from anon, authenticated;

-- schema-21 creates chronic_conditions and its policies but never enables RLS;
-- live has it on, and the deployment review's check ("RLS on for every table")
-- expects it. The policies already match live. service_role bypasses RLS, so
-- the API is unaffected.
alter table public.chronic_conditions enable row level security;
