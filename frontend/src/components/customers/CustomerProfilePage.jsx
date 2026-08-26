import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { ageFrom, count, date, initials, plural } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import FormDialog from '../../patterns/FormDialog';
import ConfirmDialog, { useConfirm } from '../../patterns/ConfirmDialog';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import Card, { CardBody } from '../../ui/Card';
import Field from '../../ui/Field';
import { NumericInput } from '../../ui/Input';
import Select from '../../ui/Select';
import Link from '../../ui/Link';
import Pagination from '../../ui/Pagination';
import EmptyState from '../../ui/EmptyState';
import ErrorState from '../../ui/ErrorState';
import Skeleton, { SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';
import { Money } from '../../domain/Money';
import { AdherenceBadge, PaymentBadge } from '../../domain/StatusBadge';
import { MedicineSearchInput } from '../../hooks/useMedicineSearch';

export default function CustomerProfilePage() {
  const { id } = useParams();
  const { isOwner } = useAuth();
  const toast = useToast();
  const stopTracking = useConfirm();
  const toggleActive = useConfirm();

  const [customer, setCustomer] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyPagination, setHistoryPagination] = useState({});
  const [schedules, setSchedules] = useState([]);
  const [conditions, setConditions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const fetchSchedules = useCallback(
    () => api.get(`/chronic-care/customers/${id}/schedules`).then((r) => setSchedules(r.data.schedules)).catch(() => {}),
    [id]
  );

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, h, sched, cond] = await Promise.all([
        api.get(`/customers/${id}`),
        api.get(`/customers/${id}/history`),
        api.get(`/chronic-care/customers/${id}/schedules`),
        api.get('/chronic-care/condition-options'),
      ]);
      setCustomer({ ...c.data.customer, age_years: ageFrom(c.data.customer.date_of_birth) });
      setHistory(h.data.bills);
      setHistoryPagination(h.data.pagination);
      setSchedules(sched.data.schedules);
      setConditions(cond.data.conditions);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const goToHistoryPage = async (page) => {
    const r = await api.get(`/customers/${id}/history?page=${page}`);
    setHistory(r.data.bills);
    setHistoryPagination(r.data.pagination);
  };

  const handleToggleActive = async () => {
    const action = customer.is_active ? 'deactivate' : 'reactivate';
    const r = await api.patch(`/customers/${id}/${action}`);
    setCustomer((c) => ({ ...c, is_active: r.data.customer.is_active }));
    toast.success(`${customer.name} ${r.data.customer.is_active ? 'reactivated' : 'deactivated'}.`);
  };

  const handleStopTracking = async () => {
    const schedule = stopTracking.target;
    await api.patch(`/chronic-care/schedules/${schedule.schedule_id}/deactivate`);
    toast.success(`Stopped tracking ${schedule.medicine_name}.`);
    fetchSchedules();
  };

  if (error) {
    return (
      <div>
        <Link to="/customers" variant="standalone" padded className="mb-s4 inline-block">← Back to customers</Link>
        <ErrorState title="Couldn't load this customer" message={error.message} onRetry={fetchAll} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-s4">
        <Skeleton className="h-32 rounded-card" />
        <SkeletonRows count={4} />
      </div>
    );
  }

  if (!customer) return null;

  // Age is computed once, when the profile loads, rather than on every render:
  // reading the clock during render is impure and makes the output depend on
  // when React happened to re-render.
  const age = customer.age_years ?? null;

  return (
    <div>
      <Link to="/customers" variant="standalone" padded className="mb-s4 inline-block">← Back to customers</Link>

      <Card className="mb-s5">
        <CardBody>
          <div className="flex flex-wrap items-start gap-s3">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-pill bg-primary text-md font-bold text-primary-foreground">
              {initials(customer.name)}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-s2">
                <h1 className="text-md font-bold text-foreground">{customer.name}</h1>
                {!customer.is_active && <Badge tone="neutral">Inactive</Badge>}
              </div>
              <dl className="mt-s2 grid gap-x-s5 gap-y-s1 text-base sm:grid-cols-2">
                {customer.phone && <Detail label="Phone" value={customer.phone} />}
                {age !== null && <Detail label="Age" value={`${age} years`} />}
                {customer.email && <Detail label="Email" value={customer.email} />}
                {customer.address && <Detail label="Address" value={customer.address} />}
              </dl>
            </div>

            {isOwner && (
              <Button
                variant={customer.is_active ? 'ghost' : 'secondary'}
                size="compact"
                className={customer.is_active ? 'text-destructive' : 'text-accent'}
                onClick={() => toggleActive.ask(customer)}
              >
                {customer.is_active ? 'Deactivate' : 'Reactivate'}
              </Button>
            )}
          </div>

          <div className="mt-s4 grid grid-cols-3 gap-s3 border-t border-border pt-s3">
            <Stat label="Bills"><span className="tabular text-sm font-bold text-foreground">{count(customer.total_bills || 0)}</span></Stat>
            <Stat label="Total spent"><Money value={customer.total_spent} whole /></Stat>
            <Stat label="Last visit">
              <span className="text-sm font-bold text-foreground">
                {customer.last_purchase_at ? date(customer.last_purchase_at) : 'Never'}
              </span>
            </Stat>
          </div>

          {customer.notes && (
            <p className="mt-s3 rounded-control bg-muted p-s2 text-base text-muted-foreground">{customer.notes}</p>
          )}
        </CardBody>
      </Card>

      <section aria-labelledby="ongoing" className="mb-s5">
        <div className="mb-s3 flex flex-wrap items-center justify-between gap-s3">
          <h2 id="ongoing" className="text-sm font-bold text-foreground">Ongoing medications</h2>
          <Button variant="secondary" size="compact" onClick={() => setScheduleOpen(true)}>
            <PlusIcon className="h-4 w-4" />
            Track a medication
          </Button>
        </div>

        {schedules.length === 0 ? (
          <EmptyState
            title="No ongoing medications tracked"
            body="Tracking a repeat medicine tells staff at the counter when this patient is overdue or refilling early. It never blocks a sale — it just prompts a conversation."
          />
        ) : (
          <ul className="flex flex-col gap-s2">
            {schedules.map((s) => (
              <li
                key={s.schedule_id}
                className="flex flex-wrap items-start justify-between gap-s3 rounded-card border border-border bg-card p-s3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-s2">
                    <span className="text-base font-bold text-foreground">{s.medicine_name}</span>
                    <AdherenceBadge status={s.status} />
                  </div>
                  {s.condition_name && <p className="text-base text-muted-foreground">{s.condition_name}</p>}
                  <p className="text-base text-muted-foreground">
                    Every {plural(s.refill_cycle_days, 'day')}
                    {s.last_purchased_date
                      ? ` · last collected ${plural(s.days_since_last_purchase, 'day')} ago`
                      : ' · not collected yet'}
                  </p>
                </div>
                <Button variant="ghost" size="compact" className="text-destructive" onClick={() => stopTracking.ask(s)}>
                  Stop tracking
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history">
        <h2 id="history" className="mb-s3 text-sm font-bold text-foreground">Purchase history</h2>
        {history.length === 0 ? (
          <EmptyState
            title="No purchases yet"
            body="Bills rung up against this customer will appear here, newest first."
          />
        ) : (
          <>
            <ul className="flex flex-col gap-s2">
              {history.map((b) => (
                <li
                  key={b.id}
                  className="flex min-h-target flex-wrap items-center justify-between gap-s3 rounded-card border border-border bg-card px-s3 py-s2"
                >
                  <div className="min-w-0">
                    <span className="block font-mono text-base font-bold text-foreground">{b.bill_number}</span>
                    <span className="block text-base text-muted-foreground">
                      {date(b.created_at)} · {plural(b.item_count, 'item')}
                    </span>
                  </div>
                  <div className="flex items-center gap-s3">
                    <PaymentBadge mode={b.payment_mode} />
                    <Money value={b.total} />
                  </div>
                </li>
              ))}
            </ul>

            <Pagination
              page={historyPagination.page}
              pages={historyPagination.pages}
              total={historyPagination.total}
              limit={historyPagination.limit}
              onPageChange={goToHistoryPage}
              itemNoun="bills"
            />
          </>
        )}
      </section>

      <AddScheduleModal
        customerId={id}
        conditions={conditions}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        onCreated={() => { fetchSchedules(); toast.success('Medication schedule created.'); }}
      />

      <ConfirmDialog
        {...stopTracking.props}
        destructive
        title={`Stop tracking ${stopTracking.target?.medicine_name}?`}
        body="Staff will no longer be prompted about this patient's refill timing for this medicine. The purchase history stays intact, and you can start tracking it again later."
        confirmLabel="Stop tracking"
        onConfirm={handleStopTracking}
      />

      <ConfirmDialog
        {...toggleActive.props}
        destructive={customer.is_active}
        title={customer.is_active ? `Deactivate ${customer.name}?` : `Reactivate ${customer.name}?`}
        body={
          customer.is_active
            ? "They won't appear when staff search for a customer at the counter. Their bills and history are kept."
            : 'They will appear again when staff search for a customer at the counter.'
        }
        confirmLabel={customer.is_active ? 'Deactivate customer' : 'Reactivate customer'}
        onConfirm={handleToggleActive}
      />
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div className="flex gap-s2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{value}</dd>
    </div>
  );
}

function Stat({ label, children }) {
  return (
    <div className="flex flex-col gap-s1">
      {children}
      <span className="text-base text-muted-foreground">{label}</span>
    </div>
  );
}

function AddScheduleModal({ customerId, conditions, open, onOpenChange, onCreated }) {
  const [medicine, setMedicine] = useState(null);
  const [conditionId, setConditionId] = useState('');
  const [cycle, setCycle] = useState('30');
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (open) { setMedicine(null); setConditionId(''); setCycle('30'); setErrors({}); }
  }, [open]);

  const validate = () => {
    const found = {};
    if (!medicine) found.medicine = 'Search for and pick the medicine to track.';
    const days = parseInt(cycle, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      found.cycle = 'Enter how many days a course lasts, between 1 and 365.';
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    await api.post('/chronic-care/schedules', {
      customer_id: customerId,
      medicine_id: medicine.id,
      condition_id: conditionId || null,
      refill_cycle_days: parseInt(cycle, 10),
    });
    onCreated();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Track a medication"
      description="Staff see a prompt at the counter when this patient collects much earlier or later than the cycle. It never blocks the sale."
      submitLabel="Start tracking"
      onSubmit={handleSubmit}
    >
      {medicine ? (
        <Field label="Medicine">
          <div className="flex min-h-target items-center justify-between gap-s3 rounded-control border border-input bg-muted px-s3">
            <span className="min-w-0 truncate text-base font-bold text-foreground">{medicine.name}</span>
            <Button variant="ghost" size="compact" type="button" onClick={() => setMedicine(null)}>Change</Button>
          </div>
        </Field>
      ) : (
        <div>
          <MedicineSearchInput label="Medicine" onSelect={setMedicine} placeholder="Search the catalogue…" />
          {errors.medicine && <p role="alert" className="mt-s1 text-base text-destructive">{errors.medicine}</p>}
        </div>
      )}

      <Field label="Diagnosed condition" hint="(optional)">
        <Select value={conditionId} onChange={(e) => setConditionId(e.target.value)} placeholder="None specified">
          {conditions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>

      <Field label="Refill cycle" required hint="days" error={errors.cycle}>
        <NumericInput integer value={cycle} onChange={setCycle} />
      </Field>
    </FormDialog>
  );
}
