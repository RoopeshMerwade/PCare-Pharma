import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Sparkline from './Sparkline';

describe('Sparkline', () => {
  const trend = [
    { value: 10 },
    { value: 0 },
    { value: 25 },
    { value: 18 },
  ];

  it('renders a fixed-size line, hidden from assistive tech', () => {
    const { container } = render(<Sparkline data={trend} />);
    const wrapper = container.firstChild;
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    // Fixed dimensions — no ResponsiveContainer, so it renders in jsdom too.
    expect(container.querySelector('svg.recharts-surface')).toBeInTheDocument();
    expect(container.querySelector('.recharts-line')).toBeInTheDocument();
  });

  it('renders nothing for a series too short to be a trend', () => {
    expect(render(<Sparkline data={[{ value: 4 }]} />).container.firstChild).toBeNull();
    expect(render(<Sparkline data={[]} />).container.firstChild).toBeNull();
    expect(render(<Sparkline data={null} />).container.firstChild).toBeNull();
  });
});
