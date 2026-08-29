-- ============================================================
-- SCHEMA 34: RPC PRIVILEGE HARDENING & DEFENSE IN DEPTH
--
-- Restricts EXECUTE permissions on privileged database functions so that
-- they can ONLY be invoked via Express on the `service_role` connection
-- and cannot be called directly via PostgREST by `anon` or `authenticated` clients.
-- ============================================================

-- 1. Privileged Atomic Mutation Functions
revoke all on function public.approve_customer_return_atomic(uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_customer_return_atomic(uuid, uuid) to service_role;

revoke all on function public.commit_supplier_invoice(uuid, uuid) from public, anon, authenticated;
grant execute on function public.commit_supplier_invoice(uuid, uuid) to service_role;

revoke all on function public.receive_purchase_atomic(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.receive_purchase_atomic(uuid, uuid, jsonb) to service_role;

revoke all on function public.receive_purchase_atomic(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.receive_purchase_atomic(uuid, uuid, jsonb, text) to service_role;

revoke all on function public.send_supplier_return_atomic(uuid, uuid) from public, anon, authenticated;
grant execute on function public.send_supplier_return_atomic(uuid, uuid) to service_role;

revoke all on function public.create_bill_atomic(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_bill_atomic(jsonb, jsonb) to service_role;

-- 2. Reporting & Aggregation Functions
revoke all on function public.get_sales_totals_summary(date, date) from public, anon, authenticated;
grant execute on function public.get_sales_totals_summary(date, date) to service_role;

revoke all on function public.top_medicines_by_qty(date, date, integer) from public, anon, authenticated;
grant execute on function public.top_medicines_by_qty(date, date, integer) to service_role;

revoke all on function public.match_suppliers_trgm(text, integer) from public, anon, authenticated;
grant execute on function public.match_suppliers_trgm(text, integer) to service_role;
