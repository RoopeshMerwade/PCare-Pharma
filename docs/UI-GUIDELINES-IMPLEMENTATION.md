# UI Guidelines — implementation record

The frontend implements the **Pharmacy Admin Dashboard UI Guidelines** (Shadcn UI
foundation). This file records where the implementation departs from the spec as
written, and why. Every departure is either arithmetic (the spec fails its own
Section 4 criteria) or an internal contradiction between two of its sections.

Token values and their measured contrast ratios live in
`frontend/src/styles/tokens.css`. This document is the reasoning; that file is
the source of truth.

---

## 1. Colour, resolved

The spec states colour in `lab()` / `oklab()`. Converted to sRGB it is a
mint-green theme on a green-biased neutral scale:

| Spec token | sRGB |
|---|---|
| `color.text.primary` | `#1E2B25` |
| `color.text.tertiary` | `#465951` |
| `color.surface.strong` | `#00D393` |
| `color.surface.raised` | `#F9FAF9` |
| `color.border.default` | `#E1E9E5` |
| `color.border.muted` | `#C6D1CB` |
| `color.focus.ring` | `#00D492` |
| `color.surface.base` | `#000000` |

## 2. Where the spec fails its own acceptance criteria

| Pairing | Ratio | Required | Criterion |
|---|---|---|---|
| White label on `surface.strong` | **1.96:1** | 4.5:1 | A1 |
| `focus.ring` on `surface.strong` | **1.01:1** | 3:1 | A3 (§3.1 mandates this exact case) |
| `border.default` on white | **1.24:1** | 3:1 | A2 |
| `border.muted` on white | **1.69:1** | 3:1 | A2 |
| `text.primary` on `surface.base` `#000000` | **1.43:1** | 4.5:1 | A1 |

## 3. Rulings

**R1 — the canvas is light.** `surface.base` `#000000` is treated as an
extraction artifact: it scores 1.43:1 against the body text token and is
inconsistent with every other value in the set. Canvas is `#EFF4F1`.

**R2 — primary buttons take dark labels.** No new colour needed:
`text.primary` on `surface.strong` is **7.52:1**. Mint is a light accent and can
only ever carry dark text. Encoded as `primary-foreground` in the Tailwind
config so it is not a per-usage decision.

**R3 — one new focus-ring token.** The specified ring is invisible on the button
§3.1 explicitly requires it to be visible on. `#005F40` — the same hue driven
dark — is **7.75:1** on the canvas and **3.96:1** on the mint button. One value,
every surface, no exceptions list.

**R4 — the border tokens are mis-assigned, not wrong.** WCAG 1.4.11 governs
*controls*, not decorative dividers. `border.default` therefore stays exactly as
specified for table rules and card edges; a new `border.control` `#7E938B`
(**3.12:1**) takes input, select and checkbox outlines. §3.5 pointing inputs at
the decorative token is the actual defect.

**R5 — critical stock cannot be green.** §2.2 aliases `status.critical`,
`outOfStock` and the `destructive` button all to `surface.strong`, which would
render "Out of Stock" in green and make "Delete Medicine" indistinguishable from
"Complete Sale". Two ramps are added: **danger `#B3261E`** (6.54:1) and
**warning `#8A5A00`** (5.93:1), each with a wash for badge fills. This is the one
place §2.2's "aliases only" rule is deliberately broken, and it is broken because
§3.1 requires destructive to be distinguishable and §5 requires status to be
truthful.

**R6 — `status.ok` inherits the mint wash.** With low stock now amber, the
"surface.strong at reduced opacity" treatment §2.2 gave `lowStock` is free; a
mint wash for healthy stock is also the reading a pharmacist expects.

**R7 — elevation is carried by shadow, not fill.** §2.2 assigns
`surface.raised` to modals, but on a light canvas a `#F9FAF9` panel against
`#FFFFFF` cards is invisible. Modals use `surface.muted` + `shadow.2` — which is
the spec's own elevation model in §2.4 — and `surface.raised` keeps the roles
§3.5 and §3.7 actually give it (disabled input fill, selected row).

## 4. Contradictions between sections

**Input radius.** §2.4 forbids the 22–28px radii on inputs and table rows; §3.5
then assigns `radius.xs` to inputs. Resolved with a `radius.control` step at
**8px**: buttons and badges keep the 22px pill, cards and modals keep 28px, and
controls in dense grids get 8px.

**Type scale.** `font.size.xs` and `font.size.base` are both 14px. Implemented
as one value with `xs` aliased to it, rather than two identical entries. The
Tailwind `fontSize` scale is **overridden, not extended**, so nothing below 14px
exists as a class and §2.1's floor cannot be breached by accident.

**`space.7`.** Kept at its literal 101.77px rather than rounded, since §6
forbids substituting one-off values. Restricted to page-level containers by lint.

## 5. Deliberate additions

| Addition | Why |
|---|---|
| `--color-surface-strong-hover/-active` | §3.1 requires hover/active to step *darker*. An opacity modifier composites mint over a light canvas and makes it *paler* — the opposite of the specified behaviour. |
| `--bottom-bar-clearance` | The mobile bottom bar's height and the page's bottom padding have to move together; a shared constant beats a per-page guess. |
| `--target-min` | §3.1/A6's 44px, referenced once rather than re-typed. |
| `--color-chart-1…8` + resolved `--chart-*` layer | Chart series palette. The badge hues could not be reused: they sit in a 0.018 relative-luminance band (documented in `Badge.jsx` as grayscale-indistinguishable), which disqualifies them as a categorical series scale. The eight chart slots are a separate set validated for colour-vision-deficiency separation and lightness in both themes against the actual card surfaces; the slot *order* is the safety mechanism and must not change. Recharts takes colours as JS props where §6 bans raw values, so components pass `"var(--chart-N)"` strings and resolution stays in CSS — which is also what makes a theme toggle recolour mounted charts with no re-render. Measured results are recorded beside the tokens in `tokens.css`; three light-mode slots sit below 3:1 on the card, and the obligatory relief is the "Show data table" view every `ChartCard` carries. |

## 6. Enforcement

`npm run lint` fails the build on:

- stock Tailwind or legacy palette classes (`slate-*`, `blue-*`, `navy-*`, …)
- arbitrary values on any scale the spec defines — spacing, type, radius, shadow, duration, colour
- raw hex / `rgb()` / `lab()` / `oklab()` in component code
- `space.7` inside a component
- `confirm()` / `alert()` / `prompt()`
- a component defined inside another component
- `ui/` importing from `domain/`, `patterns/`, `components/` or `hooks/`

`npm run check` runs lint, the test suite and the production build together.

The one sanctioned exception is `PRESET_COLORS` in `CategoryModal.jsx`: the
swatches an owner picks from to tell their own categories apart. They are data,
not styling, and the chosen colour only ever lands on a decorative dot whose
adjacent label is rendered in `foreground` — so legibility is guaranteed
whatever the owner picks.

## 7. Still open

**A9 is not fully satisfied.** Owner-only fields (cost price, vendor, margin) are
absent from the Staff DOM, but the API still returns them. A9 and §6 require
absence from the response payload, and the QA checklist asks for verification
against real Staff-session responses. Role-aware field selection in the affected
services is the outstanding work.

### A9 and Module 23 — a deliberate, scoped exception

Supplier invoice ingestion (`/supplier-invoices`) shows purchase rates to Staff,
and that is intended rather than an oversight of the above.

A9 keeps cost, vendor and margin out of Staff view because a counter session has
no business reason to see them. Goods inward is the case where it does: the whole
task is checking a printed rate, a batch number and an expiry against the carton
in your hands. A screen that hid the rate would make the check impossible, and the
alternative — the owner personally transcribing every delivery — is the manual
work this module exists to remove.

So the exception is drawn as narrowly as the task allows:

- **Rate, MRP and selling price are visible to Staff**, because they are the
  values being verified.
- **Margin is not.** `InvoiceLineCard` gates the per-unit margin readout on
  `isOwner`, so it is absent from the Staff tree rather than hidden — the same
  control A9 asks for everywhere else.
- **Approval is owner-only**, enforced on the route (`authorize('owner')`) and
  again inside `commit_supplier_invoice()`. Staff can correct a draft; only the
  owner can turn one into stock.

Nothing here changes what the rest of the app owes A9. When role-aware field
selection lands in the other services, this module keeps its exception and should
carry a comment saying so — which `supplier-invoices.routes.js` already does.

### A9 and Module 30 — the second deliberate, scoped exception

Stock requisitions (`/stock-requisitions`) show Staff what the pharmacy last paid
each distributor. Same shape of argument as Module 23, different task.

The feature exists so the person who notices an empty shelf can say which
distributor to reorder from, at the best price we have on record. **You cannot
choose the cheapest of three vendors without seeing three prices.** A screen that
hid them would leave Staff picking a distributor at random, which is worse than
not asking them at all.

The exception is drawn as narrowly as the task allows, and narrower than Module
23's:

- **One endpoint.** `GET /stock-requisitions/vendor-prices` is the only place a
  Staff session sees a vendor rate. It is deliberately not hung off `/medicines`,
  where it would look like a general capability and invite reuse that widens the
  exception without anyone deciding to.
- **One view, six columns.** It reads `medicine_vendor_prices`, which exposes
  `medicine_id, supplier_id, supplier_name, last_unit_cost, last_mrp,
  last_purchased_on` and nothing else. The view is the boundary: even a careless
  `select('*')` against it cannot widen the exception.
- **`/purchases`, `/purchase-items` and `/suppliers` are unchanged** and stay
  owner-only — including at the database level, where `schema-29-rls-lockdown.sql`
  dropped their read policies.
- **What Staff see:** the distributor's name, the rate we last paid, the MRP, and
  how old that rate is. **What they do not:** phone, contact person, email, GST or
  drug-licence number, credit terms, outstanding balance, or any margin. None of
  those help *choose* a vendor — they help *ring* one, which is the owner's job
  and happens after approval.
- **Approval and both exports are owner-only**, enforced on the route with
  `authorize('owner')`. Staff raise requests; only the owner turns one into an
  order.

**Unlike the older modules, Module 30 does not inherit the A9 debt named at the
top of this section.** It is written to the standard from its first commit:
`listRequisitions` scopes Staff to their own rows server-side, `getRequisitionById`
re-applies that scope so a colleague's record cannot be reached by id, and
`supplier_phone` is not merely stripped for Staff — `itemSelect()` never selects
it, so it does not enter the process on their behalf. Everything a payload
contains passes through one `presentItem()`. When role-aware field selection lands
in the other services, this module needs no retrofit.
