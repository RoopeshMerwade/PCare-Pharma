-- ============================================================
-- SCHEMA 33: RLS POLICY REFACTORING WITH public.is_owner()
--
-- Replaces all legacy inline subqueries:
--   EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'owner')
-- with the SECURITY DEFINER function:
--   public.is_owner()
--
-- This cleanly eliminates PostgreSQL 42P17 infinite recursion when
-- evaluating RLS on public.users while maintaining identical authorization semantics.
-- ============================================================

-- 1. Bills
drop policy if exists "owner_update_bills" on public.bills;
create policy "owner_update_bills" on public.bills
  for update using (public.is_owner());

-- 2. Customer Returns
drop policy if exists "owner_update_cr" on public.customer_returns;
create policy "owner_update_cr" on public.customer_returns
  for update using (public.is_owner());

-- 3. Customers
drop policy if exists "owner_update_customer" on public.customers;
create policy "owner_update_customer" on public.customers
  for update using (public.is_owner());

-- 4. Medicine Categories
drop policy if exists "owner_insert_category" on public.medicine_categories;
create policy "owner_insert_category" on public.medicine_categories
  for insert with check (public.is_owner());

drop policy if exists "owner_update_category" on public.medicine_categories;
create policy "owner_update_category" on public.medicine_categories
  for update using (public.is_owner());

-- 5. Medicines
drop policy if exists "owner_insert_medicine" on public.medicines;
create policy "owner_insert_medicine" on public.medicines
  for insert with check (public.is_owner());

drop policy if exists "owner_update_medicine" on public.medicines;
create policy "owner_update_medicine" on public.medicines
  for update using (public.is_owner());

-- 6. Notifications
drop policy if exists "user_update_notifications" on public.notifications;
create policy "user_update_notifications" on public.notifications
  for update using (user_id = auth.uid() or public.is_owner());

-- 7. Pharmacy Settings
drop policy if exists "owner_write_settings" on public.pharmacy_settings;
create policy "owner_write_settings" on public.pharmacy_settings
  for all using (public.is_owner());

-- 8. Purchases & Purchase Items
drop policy if exists "owner_write_purchases" on public.purchases;
create policy "owner_write_purchases" on public.purchases
  for all using (public.is_owner());

drop policy if exists "owner_write_purchase_items" on public.purchase_items;
create policy "owner_write_purchase_items" on public.purchase_items
  for all using (public.is_owner());

-- 9. Staff Attendance
drop policy if exists "owner_insert_attendance" on public.staff_attendance;
create policy "owner_insert_attendance" on public.staff_attendance
  for insert with check (public.is_owner());

drop policy if exists "owner_read_attendance" on public.staff_attendance;
create policy "owner_read_attendance" on public.staff_attendance
  for select using (public.is_owner());

drop policy if exists "owner_update_attendance" on public.staff_attendance;
create policy "owner_update_attendance" on public.staff_attendance
  for update using (public.is_owner());

-- 10. Staff Invites
drop policy if exists "owner_manage_invites" on public.staff_invites;
create policy "owner_manage_invites" on public.staff_invites
  for all using (public.is_owner());

-- 11. Supplier Returns & Items
drop policy if exists "owner_all_sr" on public.supplier_returns;
create policy "owner_all_sr" on public.supplier_returns
  for all using (public.is_owner());

drop policy if exists "owner_all_sr_items" on public.supplier_return_items;
create policy "owner_all_sr_items" on public.supplier_return_items
  for all using (public.is_owner());

-- 12. Suppliers
drop policy if exists "owner_write_suppliers" on public.suppliers;
create policy "owner_write_suppliers" on public.suppliers
  for all using (public.is_owner());

-- 13. Users
drop policy if exists "owner_insert_user" on public.users;
create policy "owner_insert_user" on public.users
  for insert with check (public.is_owner());

drop policy if exists "owner_read_all" on public.users;
create policy "owner_read_all" on public.users
  for select using (public.is_owner());

drop policy if exists "owner_update_any" on public.users;
create policy "owner_update_any" on public.users
  for update using (public.is_owner());
