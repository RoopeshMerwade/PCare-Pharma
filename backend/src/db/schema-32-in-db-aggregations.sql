-- ═══════════════════════════════════════════════════════════════════════════
-- SCHEMA 32: In-Database Aggregations for High-Volume Reporting and Billing
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.top_medicines_by_qty(p_from date, p_to date, p_limit int default 10)
returns table (
  medicine_id uuid,
  name text,
  unit text,
  total_qty bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    bi.medicine_id,
    m.name,
    m.unit,
    coalesce(sum(bi.qty), 0)::bigint as total_qty
  from public.bill_items bi
  join public.medicines m on m.id = bi.medicine_id
  join public.bills b on b.id = bi.bill_id
  where b.created_at >= (p_from::text || 'T00:00:00+05:30')::timestamptz
    and b.created_at <= (p_to::text || 'T23:59:59.999+05:30')::timestamptz
  group by bi.medicine_id, m.name, m.unit
  order by total_qty desc
  limit coalesce(p_limit, 10);
$$;

create or replace function public.get_sales_totals_summary(p_from date, p_to date)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'count', coalesce(sum(bill_count), 0)::int,
    'total', coalesce(sum(total_revenue), 0)::numeric,
    'cash', coalesce(sum(cash_total), 0)::numeric,
    'upi', coalesce(sum(upi_total), 0)::numeric,
    'credit', coalesce(sum(credit_total), 0)::numeric,
    'card', coalesce(sum(card_total), 0)::numeric
  )
  from public.daily_sales_summary
  where sale_date >= p_from and sale_date <= p_to;
$$;
