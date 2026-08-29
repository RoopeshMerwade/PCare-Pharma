-- ============================================================
-- SCHEMA 35: INVENTORY CONCURRENCY & INTEGRITY HARDENING
--
-- 1. Upgrades `check_no_negative_stock` trigger function to acquire a row-level
--    lock (`FOR UPDATE`) on `inventory_batches` before evaluating current stock.
--    This guarantees that all negative sealed stock movements (manual adjustments,
--    supplier returns, expiry write-offs) are strictly serialized and cannot race.
--
-- 2. Removes obsolete legacy 3-parameter overload of `receive_purchase_atomic`
--    to prevent PostgreSQL 42725 function signature ambiguity errors.
-- ============================================================

-- 1. Upgrade trigger with FOR UPDATE mutex
CREATE OR REPLACE FUNCTION public.check_no_negative_stock()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  current_stock int;
begin
  if NEW.change_qty < 0 then
    perform 1 from public.inventory_batches where id = NEW.batch_id for update;
    select coalesce(sum(change_qty), 0) into current_stock
    from public.inventory_ledger where batch_id = NEW.batch_id;
    if current_stock + NEW.change_qty < 0 then
      raise exception 'INSUFFICIENT_STOCK: Batch would go below 0 (current: %, requested: %)',
        current_stock, abs(NEW.change_qty);
    end if;
  end if;
  return NEW;
end; $function$;

-- 2. Clean up legacy overload
drop function if exists public.receive_purchase_atomic(uuid, uuid, jsonb);
