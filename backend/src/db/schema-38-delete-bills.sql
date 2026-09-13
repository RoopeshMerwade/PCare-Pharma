-- ============================================================================
-- schema-38 — owner bill deletion (permanent; stock is NOT returned)
-- ============================================================================
--
-- The one exception to "a bill is forever". The owner may delete a single bill,
-- or every bill in a range of India-time days. Deleting REMOVES the bill, its
-- lines, any rejected customer returns and its adherence acknowledgments.
--
-- It never touches inventory_ledger or loose_unit_ledger. The `sale` and
-- `strip_opened` rows the bill wrote stay exactly as they are (ref_id still
-- names the bill; there is no FK, and block_ledger_mutation forbids edits), so
-- the stock the bill sold stays sold. That is the requirement, not a side effect.
--
-- Everything that reports sales is computed live from bills and bill_items —
-- bills_with_totals, daily_sales_summary (and get_sales_totals_summary on top of
-- it), customers_with_stats, margin_analytics, medication_schedule_status,
-- top_medicines_by_qty — so removing the rows is the whole of "the rest of the
-- app adapts". No view changes.
--
-- Rules the functions enforce, under a row lock:
--
--   · only an ACTIVE OWNER (checked here as well as by the API's route guard);
--   · a reason of at least 5 characters;
--   · a bill with a PENDING or APPROVED customer return cannot be deleted. An
--     approved return already refunded money and put stock back; a pending one
--     is a claim nobody has decided. Rejected returns moved nothing and are
--     removed with the bill (their FK would otherwise block the delete);
--   · a range delete must match the preview the owner confirmed — same number
--     of bills and same total — or it refuses with RANGE_CHANGED;
--   · at most 1000 bills per call.
--
-- The audit row is written INSIDE the transaction, with a full snapshot of each
-- deleted bill and its lines. utils/audit.js is fire-and-forget, which is the
-- wrong guarantee for an irreversible act: a deletion must never exist without
-- the record of what it removed.
--
-- This replaces an unapplied draft, schema-38-delete-bills-range.sql, which could
-- not run (it updated medication_schedules.bill_id, a column that does not
-- exist) and cascade-deleted approved returns. Its two functions are dropped
-- below in case that draft was ever applied anywhere.
--
-- Depends on: schema-06-10 (bills, bill_items), schema-11-14 (customer_returns),
-- schema-21 (adherence_acknowledgments), schema-27 (bill_items.is_loose),
-- auth.sql (audit_logs, users). Safe to re-run: every function is
-- `create or replace`, every drop is `if exists`.
-- ============================================================================

drop function if exists public.delete_bills_in_range_atomic(timestamptz, timestamptz, uuid, boolean);
drop function if exists public.preview_bills_in_range(timestamptz, timestamptz);

-- The ONE definition of "bills in these India-time days". Half-open at the next
-- IST midnight — the same calendar daily_sales_summary buckets by.
create or replace function public.bills_in_ist_range(p_from date, p_to date)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(id order by id), '{}')
    from public.bills
   where created_at >= (p_from::text || 'T00:00:00+05:30')::timestamptz
     and created_at <  ((p_to + 1)::text || 'T00:00:00+05:30')::timestamptz;
$$;

-- Read-only. What deleting these bills would remove, and what blocks it.
create or replace function public.preview_bill_deletion(p_bill_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'bill_count',   (select count(*) from public.bills where id = any(p_bill_ids)),
    'item_count',   (select count(*) from public.bill_items where bill_id = any(p_bill_ids)),
    'total_amount', (select coalesce(sum(total), 0) from public.bills_with_totals where id = any(p_bill_ids)),
    'sealed_units_not_restocked',
                    (select coalesce(sum(qty), 0) from public.bill_items
                      where bill_id = any(p_bill_ids) and not is_loose),
    'loose_units_not_restocked',
                    (select coalesce(sum(qty), 0) from public.bill_items
                      where bill_id = any(p_bill_ids) and is_loose),
    'blocked',      (select coalesce(jsonb_agg(jsonb_build_object(
                              'bill_id', b.id, 'bill_number', b.bill_number,
                              'return_number', cr.return_number, 'return_status', cr.status)
                            order by b.bill_number, cr.return_number), '[]')
                       from public.customer_returns cr
                       join public.bills b on b.id = cr.bill_id
                      where cr.bill_id = any(p_bill_ids) and cr.status <> 'rejected')
  );
$$;

create or replace function public.delete_bills_core(
  p_bill_ids   uuid[],
  p_actor_id   uuid,
  p_reason     text,
  p_scope      jsonb,
  p_ip         text,
  p_user_agent text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids       uuid[];
  v_snapshot  jsonb;
  v_total     numeric;
  v_ip        inet;
  v_bills     int;
  v_items     int;
  v_rej       int;
  v_rej_items int;
  v_acks      int;
begin
  if not exists (select 1 from public.users where id = p_actor_id and role = 'owner' and is_active) then
    raise exception 'FORBIDDEN: only an active owner can delete bills';
  end if;

  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'REASON_REQUIRED: a reason of at least 5 characters is required';
  end if;

  if cardinality(p_bill_ids) > 1000 then
    raise exception 'RANGE_TOO_LARGE: delete at most 1000 bills at once';
  end if;

  -- Lock the bills in a deterministic order, as create_bill_atomic locks batches.
  -- A concurrent customer-return insert takes KEY SHARE on the bill for its FK
  -- check, so it waits for this transaction and then fails its FK, instead of
  -- attaching a return to a bill that is being removed.
  perform 1 from public.bills where id = any(p_bill_ids) order by id for update;

  select coalesce(array_agg(id order by id), '{}') into v_ids
    from public.bills where id = any(p_bill_ids);

  if cardinality(v_ids) = 0 then
    raise exception 'BILL_NOT_FOUND: no such bill';
  end if;

  if exists (select 1 from public.customer_returns
              where bill_id = any(v_ids) and status <> 'rejected') then
    raise exception 'BILL_HAS_RETURNS: a bill with a pending or approved return cannot be deleted';
  end if;

  -- Snapshot BEFORE deleting. After this transaction the audit row is the only
  -- remaining record of what was sold, to whom, and at what price.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', bt.id, 'bill_number', bt.bill_number, 'created_at', bt.created_at,
           'created_by', bt.created_by, 'created_by_name', bt.created_by_name,
           'customer_name', bt.customer_name, 'customer_phone', bt.customer_phone,
           'payment_mode', bt.payment_mode, 'payment_status', bt.payment_status,
           'discount_amount', bt.discount_amount, 'subtotal', bt.subtotal, 'total', bt.total,
           'items', (select coalesce(jsonb_agg(to_jsonb(bi) order by bi.id), '[]')
                       from public.bill_items bi where bi.bill_id = bt.id))
         order by bt.created_at), '[]'),
         coalesce(sum(bt.total), 0)
    into v_snapshot, v_total
    from public.bills_with_totals bt
   where bt.id = any(v_ids);

  -- Foreign-key order. Only rejected returns can remain at this point.
  delete from public.customer_return_items cri
   using public.customer_returns cr
   where cri.return_id = cr.id and cr.bill_id = any(v_ids);
  get diagnostics v_rej_items = row_count;

  delete from public.customer_returns where bill_id = any(v_ids);
  get diagnostics v_rej = row_count;

  delete from public.adherence_acknowledgments where bill_id = any(v_ids);
  get diagnostics v_acks = row_count;

  delete from public.bill_items where bill_id = any(v_ids);
  get diagnostics v_items = row_count;

  delete from public.bills where id = any(v_ids);
  get diagnostics v_bills = row_count;

  -- inventory_ledger and loose_unit_ledger are deliberately untouched.

  -- audit_logs.ip_address is inet. An address the API could not describe must
  -- not be what stops an owner deleting a bill, so an unparseable one is dropped.
  begin
    v_ip := nullif(trim(p_ip), '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  insert into public.audit_logs (user_id, action, metadata, ip_address, user_agent)
  values (
    p_actor_id,
    case when p_scope->>'kind' = 'range' then 'bills_deleted_in_range' else 'bill_deleted' end,
    jsonb_build_object(
      'scope', p_scope,
      'reason', trim(p_reason),
      'stock_returned', false,
      'bill_count', v_bills,
      'item_count', v_items,
      'total_amount', v_total,
      'rejected_returns_removed', v_rej,
      'rejected_return_items_removed', v_rej_items,
      'adherence_acknowledgments_removed', v_acks,
      'bills', v_snapshot
    ),
    v_ip,
    p_user_agent
  );

  return jsonb_build_object(
    'deleted_bills', v_bills,
    'deleted_items', v_items,
    'total_amount', v_total,
    'bill_numbers', (select coalesce(jsonb_agg(e->>'bill_number'), '[]')
                       from jsonb_array_elements(v_snapshot) e)
  );
end;
$$;

create or replace function public.delete_bill_atomic(
  p_bill_id    uuid,
  p_actor_id   uuid,
  p_reason     text,
  p_ip         text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.delete_bills_core(
    array[p_bill_id], p_actor_id, p_reason,
    jsonb_build_object('kind', 'single', 'bill_id', p_bill_id),
    p_ip, p_user_agent);
end;
$$;

create or replace function public.delete_bills_in_range_atomic(
  p_from           date,
  p_to             date,
  p_actor_id       uuid,
  p_reason         text,
  p_expected_count integer,
  p_expected_total numeric,
  p_ip             text default null,
  p_user_agent     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids   uuid[];
  v_total numeric;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'INVALID_DATE_RANGE: from must be on or before to';
  end if;

  v_ids := public.bills_in_ist_range(p_from, p_to);

  if cardinality(v_ids) = 0 then
    raise exception 'NO_BILLS_IN_RANGE: there are no bills in that date range';
  end if;

  select coalesce(sum(total), 0) into v_total
    from public.bills_with_totals where id = any(v_ids);

  -- The owner confirmed one specific preview. If a bill was rung up, returned or
  -- deleted in this range since then, refuse rather than delete a set of bills
  -- they never saw.
  if p_expected_count is distinct from cardinality(v_ids)
     or p_expected_total is distinct from v_total then
    raise exception 'RANGE_CHANGED: the bills in that range changed since the preview';
  end if;

  return public.delete_bills_core(
    v_ids, p_actor_id, p_reason,
    jsonb_build_object('kind', 'range', 'date_from', p_from, 'date_to', p_to),
    p_ip, p_user_agent);
end;
$$;

-- service_role only, the schema-34 posture. delete_bills_core is deliberately
-- granted to NOBODY: it is reachable only through the two entry points, which
-- carry the range and scope checks.
--
-- Revoking from PUBLIC is not enough for that. Supabase's default privileges
-- grant EXECUTE on every new public function to service_role EXPLICITLY, so
-- without the service_role revoke below the core stays callable over PostgREST
-- with the secret key. Found by rehearsing this file against the live project.
revoke all on function public.bills_in_ist_range(date, date) from public, anon, authenticated;
revoke all on function public.preview_bill_deletion(uuid[]) from public, anon, authenticated;
revoke all on function public.delete_bills_core(uuid[], uuid, text, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_bill_atomic(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.delete_bills_in_range_atomic(date, date, uuid, text, integer, numeric, text, text) from public, anon, authenticated;

grant execute on function public.bills_in_ist_range(date, date) to service_role;
grant execute on function public.preview_bill_deletion(uuid[]) to service_role;
grant execute on function public.delete_bill_atomic(uuid, uuid, text, text, text) to service_role;
grant execute on function public.delete_bills_in_range_atomic(date, date, uuid, text, integer, numeric, text, text) to service_role;
