import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from './useTheme';
import { AppearanceCard } from '../components/settings/SettingsPages';
import ThemeToggle from '../components/common/ThemeToggle';
import { checkA11y } from '../test/axe';

// Helper component to inspect useTheme values
function ThemeConsumer() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolvedTheme">{resolvedTheme}</span>
      <button type="button" onClick={() => setTheme('light')}>Set Light</button>
      <button type="button" onClick={() => setTheme('dark')}>Set Dark</button>
      <button type="button" onClick={() => setTheme('system')}>Set System</button>
    </div>
  );
}

describe('useTheme hook and ThemeProvider', () => {
  let mediaQueryListeners = [];
  let matchMediaMatches = false;

  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    mediaQueryListeners = [];
    matchMediaMatches = false;

    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: matchMediaMatches,
      media: query,
      onchange: null,
      addListener: (cb) => mediaQueryListeners.push(cb),
      removeListener: (cb) => {
        mediaQueryListeners = mediaQueryListeners.filter((l) => l !== cb);
      },
      addEventListener: (evt, cb) => {
        if (evt === 'change') mediaQueryListeners.push(cb);
      },
      removeEventListener: (evt, cb) => {
        if (evt === 'change') {
          mediaQueryListeners = mediaQueryListeners.filter((l) => l !== cb);
        }
      },
      dispatchEvent: () => false,
    }));
  });

  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('defaults to system when localStorage is empty', () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('resolvedTheme')).toHaveTextContent('light');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('setTheme("dark") writes data-theme="dark" to <html> and persists', async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'Set Dark' }));

    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('resolvedTheme')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('pcare.theme')).toBe('dark');
  });

  it('setTheme("system") removes data-theme attribute and cleans localStorage', async () => {
    localStorage.setItem('pcare.theme', 'dark');
    document.documentElement.dataset.theme = 'dark';

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    await userEvent.click(screen.getByRole('button', { name: 'Set System' }));

    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('pcare.theme')).toBeNull();
  });

  it('flips resolvedTheme on matchMedia change while on system theme', () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('resolvedTheme')).toHaveTextContent('light');

    // Simulate OS switching to dark mode
    act(() => {
      mediaQueryListeners.forEach((listener) => listener({ matches: true }));
    });

    expect(screen.getByTestId('resolvedTheme')).toHaveTextContent('dark');

    // Simulate OS switching back to light mode
    act(() => {
      mediaQueryListeners.forEach((listener) => listener({ matches: false }));
    });

    expect(screen.getByTestId('resolvedTheme')).toHaveTextContent('light');
  });

  it('does not crash when localStorage throws (private browsing)', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Access denied');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Access denied');
    });

    expect(() => {
      render(
        <ThemeProvider>
          <ThemeConsumer />
        </ThemeProvider>
      );
    }).not.toThrow();

    expect(screen.getByTestId('theme')).toHaveTextContent('system');

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });
});

describe('Appearance Card and Theme Radios', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('exposes theme radios reachable by role="radio" and reports selection', async () => {
    render(
      <ThemeProvider>
        <AppearanceCard />
      </ThemeProvider>
    );

    const lightRadio = screen.getByRole('radio', { name: 'Light' });
    const darkRadio = screen.getByRole('radio', { name: 'Dark' });
    const systemRadio = screen.getByRole('radio', { name: 'System' });

    expect(systemRadio).toBeChecked();
    expect(lightRadio).not.toBeChecked();
    expect(darkRadio).not.toBeChecked();

    await userEvent.click(darkRadio);

    expect(darkRadio).toBeChecked();
    expect(systemRadio).not.toBeChecked();
    expect(lightRadio).not.toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('passes axe accessibility tests in both Light and Dark modes', async () => {
    const lightResult = render(
      <ThemeProvider>
        <AppearanceCard />
      </ThemeProvider>
    );
    expect(await checkA11y(lightResult.container)).toHaveNoViolations();
    lightResult.unmount();

    localStorage.setItem('pcare.theme', 'dark');
    const darkResult = render(
      <ThemeProvider>
        <AppearanceCard />
      </ThemeProvider>
    );
    expect(await checkA11y(darkResult.container)).toHaveNoViolations();
    darkResult.unmount();
  });
});

describe('ThemeToggle component', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('renders button with accessible label and opens dropdown menu', async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );

    const trigger = screen.getByRole('button', { name: 'Theme: System' });
    expect(trigger).toBeInTheDocument();

    await userEvent.click(trigger);

    const darkItem = screen.getByRole('menuitemradio', { name: 'Dark' });
    expect(darkItem).toBeInTheDocument();

    await userEvent.click(darkItem);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
