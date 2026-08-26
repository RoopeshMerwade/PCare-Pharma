import { createContext, useContext, useState, useEffect, useCallback } from 'react';

/* ═══════════════════════════════════════════════════════════════════════════
   useTheme — Context provider and hook for light, dark and system themes.

   Themes:
     - 'light'  -> writes data-theme="light" to <html>
     - 'dark'   -> writes data-theme="dark" to <html>
     - 'system' -> removes data-theme attribute, allowing CSS
                   @media (prefers-color-scheme: dark) to take over.

   Persisted in localStorage under 'pcare.theme'. Guarded with try/catch for
   private browsing modes.
   ═══════════════════════════════════════════════════════════════════════════ */

const ThemeContext = createContext(null);
const THEME_KEY = 'pcare.theme';

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        return stored;
      }
    } catch {
      // Private browsing or restricted storage
    }
    return 'system';
  });

  const [systemIsDark, setSystemIsDark] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  // Track OS-level system theme changes live
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => setSystemIsDark(e.matches);

    if (media.addEventListener) {
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    } else if (media.addListener) {
      media.addListener(handler);
      return () => media.removeListener(handler);
    }
    return undefined;
  }, []);

  const resolvedTheme = theme === 'system' ? (systemIsDark ? 'dark' : 'light') : theme;

  const setTheme = useCallback((nextTheme) => {
    setThemeState(nextTheme);
    try {
      if (nextTheme === 'system') {
        localStorage.removeItem(THEME_KEY);
      } else {
        localStorage.setItem(THEME_KEY, nextTheme);
      }
    } catch {
      // Private browsing
    }
  }, []);

  // Synchronize <html> data-theme attribute and <meta name="theme-color">
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;

    if (theme === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = theme;
    }

    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor && typeof window !== 'undefined' && window.getComputedStyle) {
      const channels = window.getComputedStyle(root).getPropertyValue('--color-surface-base').trim();
      if (channels) {
        metaThemeColor.setAttribute('content', ['rgb', '(', channels, ')'].join(''));
      }
    }
  }, [theme, resolvedTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

export default useTheme;
