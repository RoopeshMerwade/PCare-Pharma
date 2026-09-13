/* Applies the saved theme before first paint. Loaded from index.html.

   Its own file so the Content-Security-Policy can stay script-src 'self' with
   no hash to recompute whenever this changes. The colours match
   --color-surface-base in tokens.css (light / dark): the browser chrome cannot
   read a CSS variable. */
(function () {
  try {
    var theme = localStorage.getItem('pcare.theme');
    var isDark = theme === 'dark' || ((!theme || theme === 'system') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.dataset.theme = theme;
    }
    var metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', isDark ? '#0F1714' : '#EFF4F1');
    }
  } catch {
    // Storage unavailable (private mode, blocked site data): the CSS defaults apply.
  }
})();
