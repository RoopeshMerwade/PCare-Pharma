import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { checkA11y } from '../../test/axe';
import ChartFrame from './ChartFrame';
import TrendChart from './TrendChart';
import ChartCard from './ChartCard';

/* The test setup stubs ResizeObserver as a no-op (for Radix), so recharts'
   ResponsiveContainer measures 0×0 under jsdom and renders nothing. Every
   chart test therefore passes a NUMERIC width, which ChartFrame turns into a
   direct fixed-size render — the documented escape hatch. */

const ROWS = [
  { day: '2026-08-01', value: 1200 },
  { day: '2026-08-02', value: 0 },
  { day: '2026-08-03', value: 3400 },
];

const SERIES = [{ key: 'value', name: 'Revenue', color: 'var(--chart-1)' }];

describe('ChartFrame', () => {
  it('renders a named figure and, at fixed size, a real svg', () => {
    const { container } = render(
      <TrendChart
        data={ROWS}
        xKey="day"
        series={SERIES}
        width={400}
        height={200}
        label="Revenue, last 3 days"
      />
    );
    expect(screen.getByRole('figure', { name: 'Revenue, last 3 days' })).toBeInTheDocument();
    expect(container.querySelector('svg.recharts-surface')).toBeInTheDocument();
  });

  it('dims — never unmounts — while a refetch is in flight', () => {
    const { container } = render(
      <ChartFrame label="Test chart" width={200} height={100} dimmed>
        <svg />
      </ChartFrame>
    );
    const figure = container.querySelector('figure');
    expect(figure.className).toContain('opacity-60');
    expect(figure.querySelector('svg')).toBeInTheDocument();
  });
});

describe('ChartCard', () => {
  const table = {
    columns: [
      { key: 'day', label: 'Day' },
      { key: 'value', label: 'Revenue', numeric: true },
    ],
    rows: ROWS.map((r) => ({ ...r, id: r.day })),
    caption: 'Revenue by day',
  };

  it('keeps every charted value reachable without hovering, via the data table', async () => {
    const user = userEvent.setup();
    render(
      <ChartCard title="Revenue" table={table}>
        <TrendChart data={ROWS} xKey="day" series={SERIES} width={400} height={200} label="Revenue chart" />
      </ChartCard>
    );

    const toggle = screen.getByRole('button', { name: 'Show data table' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide data table' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
  });

  it('shows caller-authored empty copy instead of a chart', () => {
    render(
      <ChartCard
        title="Revenue"
        empty
        emptyTitle="No sales in this window"
        emptyBody="Widen the dates, or check a period when the shop was open."
      />
    );
    expect(screen.getByText('No sales in this window')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show data table' })).not.toBeInTheDocument();
  });

  it('has no axe violations with the chart and table open', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChartCard title="Revenue" table={table}>
        <TrendChart data={ROWS} xKey="day" series={SERIES} width={400} height={200} label="Revenue chart" />
      </ChartCard>
    );
    await user.click(screen.getByRole('button', { name: 'Show data table' }));
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
