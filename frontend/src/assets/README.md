# assets/

Images, illustrations and logo files that are **imported by code**.

```
assets/
  illustrations/   scene art — login page, empty states, error pages
  images/          photographs and raster art (jpg/png/webp)
  logos/           the P.Care mark and any supplier/partner marks
```

---

## Three places a graphic can live. Pick deliberately.

| It is… | Put it | Why |
|---|---|---|
| A **UI icon** next to a label | `src/ui/icons.jsx` | Must follow the text colour it sits beside. Inline SVG inheriting `currentColor` is the only thing that does. |
| An **illustration or logo** used by a component | **here** | Vite fingerprints it, so a redeploy can never serve a stale cached image. |
| A **favicon, og:image, manifest icon** | `public/` | Needs a stable, predictable URL that nothing hashes. See `public/README.md`. |

Do **not** add UI icons here. `ui/icons.jsx` exists precisely so an icon can inherit
`currentColor`; an `<img>` cannot, so an icon imported from this folder would keep
one fixed colour while the label beside it changed with theme, state and hover.

---

## The other folder: `frontend/public/`

Created alongside this one, and deliberately empty. Vite copies its contents to
the root of `dist/` **verbatim** — same name, no fingerprint, no processing —
so files there are referenced by absolute path (`/favicon.svg`) and never imported.

Use it only for files whose URL something **outside** the app already knows:

- `favicon.svg` / `favicon.ico` / `apple-touch-icon.png`
- `og-image.png` — the WhatsApp/social preview card
- `robots.txt`, `site.webmanifest` and its icons

Nothing a component imports should go there. An unhashed asset keeps being served
from cache under the same name after a deploy, so a changed image can show the old
version until someone hard-refreshes — which on a counter machine nobody ever does.

Note that anything in `public/` is publicly fetchable at the web root, so it takes
no internal notes and no README. That is why this section lives here instead.

**Currently missing: a favicon.** `index.html` declares no `<link rel="icon">`, so
every page load 404s on `/favicon.ico` and the tab shows a blank sheet. A single
`public/favicon.svg` in mint `#00D393` reads correctly in both light and dark
browser chrome:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```

`index.html` already hand-syncs `<meta name="theme-color">` with
`--color-surface-base`, with a comment noting that browser chrome cannot read a
CSS variable. The same caveat applies to every file in `public/`: it sits outside
the token system, so any colour in it is a copy to update by hand.

---

## Theme-awareness — read before adding an illustration

The canvas is `#EFF4F1` in light mode and `#0F1714` in dark (`styles/tokens.css`).
An `<img src={…}>` renders the file exactly as authored: it **cannot** read a CSS
variable, cannot inherit `currentColor`, and will not change when the theme toggles.

Three options, in order of preference:

1. **Author it to work on both.** Mid-tone mint (`#00D393`) and the deep greens
   (`#00734C`, `#005F40`) hold up on either canvas. Avoid near-black line work —
   `#1E2B25` all but vanishes on `#0F1714`.
2. **Ship two files** and pick at render time:
   ```jsx
   import { useTheme } from '../../hooks/useTheme';
   import light from '../../assets/illustrations/login-light.svg';
   import dark  from '../../assets/illustrations/login-dark.svg';

   const { resolvedTheme } = useTheme();   // 'light' | 'dark'
   <img src={resolvedTheme === 'dark' ? dark : light} alt="" />
   ```
3. **Inline it as a component** in `ui/` when it genuinely must track tokens —
   then it can use `currentColor` and `var(--color-…)` like the charts do
   (`ui/charts/chartTheme.js` is the precedent: colours resolve through CSS at
   paint time, so a theme toggle recolours without a re-render).

## Token discipline does not reach this folder

ESLint's no-raw-colour rule covers `src/**/*.{js,jsx}` — it does **not** parse
`.svg` files. Hex values inside an asset are therefore accepted silently and can
drift from `tokens.css` without anything failing. When commissioning or editing
artwork, pin it to the palette by hand:

| Token | Value | Use |
|---|---|---|
| `surface.strong` | `#00D393` | primary mint |
| `accent.deep` | `#00734C` | deep green |
| `focus.ring` | `#005F40` | forest, outlines |
| `status.ok.wash` | `#DFF7EE` | pale mint fill |
| `surface.base` | `#EFF4F1` | light canvas |
| `text.primary` | `#1E2B25` | near-black line work (light mode only) |

## Vite mechanics

- `import url from './logos/pcare.svg'` → a hashed URL (`/assets/pcare-a1b2c3.svg`).
- **Files under 4 KB are inlined as `data:` URIs**, not emitted separately. Normal,
  but it means a small SVG will not appear in `dist/assets/`.
- `import markup from './x.svg?raw'` → the file's text, for `dangerouslySetInnerHTML`.
  Only for artwork you authored — it is an HTML injection sink.
- `import url from './x.png?url'` → force a URL, never inlined.

Fonts are the exception and stay in `styles/fonts/`: they are referenced by
`@font-face` in CSS, not imported by a component.

## Conventions

- **Lowercase kebab-case**, describing the subject, not the page:
  `pharmacist-counter.svg`, not `login-image-2.svg`. The same art often gets reused.
- **Suffix theme variants** `-light` / `-dark`.
- **Run SVGs through SVGO** before committing. Exported artwork routinely carries
  editor metadata larger than the drawing.
- **Decorative art takes `alt=""`**, so a screen reader skips it rather than
  announcing a filename. If it carries meaning the surrounding copy does not, give
  it a real `alt` (A4).
- If this folder grows past a handful of files, add an `index.js` barrel the way
  `ui/index.js` does, so art can be re-homed without touching every call site.
