/* ═══════════════════════════════════════════════════════════════════════════
   Supplier invoice meaning — Module 23.

   domain/, not components/: this carries pharmacy meaning (what a warning code
   means, what a line's arithmetic is) and stays route-agnostic. The review
   screen, the list page and the badges all read from here, so two surfaces can
   never disagree about whether EXPIRY_TOO_SOON blocks an import.

   The line arithmetic is duplicated from the backend's
   supplier-invoices.normalize.js ON PURPOSE. The reviewer needs to watch
   "120 strips · ₹850" update as they type a pack size, and round-tripping every
   keystroke to the server to find that out would make the field feel broken.
   The server's copy is still the authority — it is what the import uses.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Warning codes ──────────────────────────────────────────────────────────
   Every code the backend can emit has a short human label here. A code with no
   entry falls back to a readable form of itself rather than rendering
   SCREAMING_CASE at the counter — but that fallback is a bug, not a feature:
   backend and frontend lists are meant to stay in step. */
const WARNING_LABELS = {
  // ── Line-level, blocking
  UNMAPPED_MEDICINE: 'Not in catalogue',
  MISSING_BATCH: 'No batch number',
  MISSING_EXPIRY: 'No expiry date',
  EXPIRED: 'Already expired',
  INVALID_DATES: 'Dates contradict',
  MISSING_QTY: 'No quantity',
  MISSING_MRP: 'No MRP',
  MISSING_COST: 'No rate',
  MISSING_SELLING_PRICE: 'No selling price',
  COST_EXCEEDS_MRP: 'Rate above MRP',
  SELLING_ABOVE_MRP: 'Price above MRP',

  // ── Line-level, advisory
  LOW_MATCH_CONFIDENCE: 'Check the match',
  EXPIRY_TOO_SOON: 'Short dated',
  LINE_TOTAL_MISMATCH: 'Total disagrees',
  BATCH_EXISTS: 'Batch already on shelf',
  PACK_UNPARSEABLE: 'Pack not understood',

  // ── Document-level, blocking
  SUPPLIER_UNRESOLVED: 'Distributor not matched',
  MISSING_INVOICE_NO: 'No invoice number',
  DUPLICATE_INVOICE: 'Already imported',
  NO_LINE_ITEMS: 'No lines read',

  // ── Document-level, advisory
  MISSING_INVOICE_DATE: 'No invoice date',
  FUTURE_INVOICE_DATE: 'Date in the future',
  TOTALS_MISMATCH: 'Totals disagree',
  LINES_TOTAL_MISMATCH: 'Lines do not sum',
  ITEM_COUNT_MISMATCH: 'Line count disagrees',
};

/** Short label for a warning code. Never returns empty. */
export function warningLabel(code) {
  if (WARNING_LABELS[code]) return WARNING_LABELS[code];
  // Readable rather than raw, so an unmapped code degrades instead of leaking.
  return String(code || 'Problem')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Badge tone for a severity. Errors are the red ramp, warnings amber (§2.2). */
export function warningTone(severity) {
  return severity === 'error' ? 'critical' : 'warning';
}

/** Splits an issue list into the two groups the UI treats differently. */
export function partitionWarnings(warnings = []) {
  return {
    errors: warnings.filter((w) => w.severity === 'error'),
    advisories: warnings.filter((w) => w.severity !== 'error'),
  };
}

/** Codes attached to one field, so a Field can show its own message inline. */
export function warningsForField(warnings = [], field) {
  return warnings.filter((w) => w.field === field);
}

/* ── Line arithmetic ─────────────────────────────────────────────────────── */

function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Stock this line takes in, in SALEABLE UNITS — strips, bottles, tubes,
 * inhalers. The denomination inventory_ledger is counted in.
 *
 * The Pack column does not appear here. "100'S" qty 5 is five strips, not five
 * hundred tablets. Mirrors totalUnits in the backend normaliser.
 *
 * Free goods are stock: they go on the shelf and they get sold. So they count
 * here, and they do NOT count in lineValue below. That asymmetry is the whole
 * reason scheme quantity is tracked as its own field.
 */
export function totalUnits(line) {
  return num(line?.qty_billed) + num(line?.qty_free);
}

/**
 * Total contents received, for display beside the unit count: 5 strips × 100 =
 * 500 tablets. Informational only — never a stock figure, never in a total.
 * Mirrors totalContent in the backend normaliser.
 */
export function totalContent(line) {
  const units = totalUnits(line);
  const perUnit = num(line?.sub_pack_quantity) || num(line?.content_quantity);
  if (!units || !perUnit) return null;
  return {
    quantity: units * perUnit,
    unit: line?.sub_pack_quantity ? (line?.sub_pack_unit || 'PACK') : (line?.content_unit || null),
  };
}

/**
 * What the line costs: billed saleable units at the per-unit cost, net of
 * discount. Mirrors lineValue in the backend normaliser.
 */
export function lineValue(line) {
  return Math.round(num(line?.qty_billed) * num(line?.unit_cost) * 100) / 100;
}

/**
 * What the invoice says the line costs: qty × rate as printed, gross of
 * discount, so it reconciles against the printed line total.
 * Mirrors printedLineValue in the backend normaliser.
 */
export function printedLineValue(line) {
  const rate = num(line?.printed_rate);
  if (!rate) return null;
  return Math.round(num(line?.qty_billed) * rate * 100) / 100;
}

/** Margin per unit at the chosen selling price, or null when either side is
 *  unknown. Owner information — the review screen gates it on role. */
export function unitMargin(line) {
  const selling = num(line?.selling_price);
  const cost = num(line?.unit_cost);
  if (!selling || !cost) return null;
  return Math.round((selling - cost) * 100) / 100;
}

/** Total the reviewer checks against the invoice's own taxable total. */
export function sumLineValues(lines = []) {
  const total = lines.filter((l) => !l.is_excluded).reduce((sum, l) => sum + lineValue(l), 0);
  return Math.round(total * 100) / 100;
}

/* ── Import readiness ────────────────────────────────────────────────────── */

/**
 * Whether Approve & Commit can run, computed locally from the same rule the
 * backend applies: errors block, warnings never do.
 *
 * The server recomputes this on every save and returns `can_import`; prefer
 * that when it is present. This exists so the button's state is right the
 * instant a value changes, before the PATCH has come back.
 */
export function canImport(invoice) {
  if (!invoice) return false;
  if (invoice.status !== 'NEEDS_REVIEW') return false;
  if ((invoice.validation_warnings || []).some((w) => w.severity === 'error')) return false;
  return !(invoice.items || []).some(
    (item) => !item.is_excluded && (item.warnings || []).some((w) => w.severity === 'error')
  );
}

/** Every blocking issue on the document, line number attached where there is
 *  one — the list the reviewer works down before approving. */
export function blockingIssues(invoice) {
  if (!invoice) return [];
  return [
    ...(invoice.validation_warnings || []).filter((w) => w.severity === 'error'),
    ...(invoice.items || [])
      .filter((i) => !i.is_excluded)
      .flatMap((i) =>
        (i.warnings || [])
          .filter((w) => w.severity === 'error')
          .map((w) => ({ ...w, line_no: i.line_no }))
      ),
  ];
}

/** What a line is called on screen: the catalogue name once mapped, the printed
 *  description until then. Never a bare id, never blank. */
export function lineTitle(line) {
  return line?.medicines?.name || line?.raw_description || `Line ${line?.line_no ?? '?'}`;
}

/**
 * Infers the most suitable catalogue unit ('strips', 'bottles', 'tubes', 'vials', 'packs', 'pcs')
 * from an invoice line's description, pack string, and sale unit.
 */
export function inferUnit(line) {
  if (!line) return 'strips';

  // 1. Direct sale_unit match from extraction
  const saleUnit = String(line.sale_unit || '').toUpperCase().trim();
  if (saleUnit.includes('STRIP')) return 'strips';
  if (saleUnit.includes('BOTTLE') || saleUnit.includes('SYRUP') || saleUnit.includes('JAR') || saleUnit.includes('TIN')) return 'bottles';
  if (saleUnit.includes('TUBE') || saleUnit.includes('OINTMENT') || saleUnit.includes('CREAM')) return 'tubes';
  if (saleUnit.includes('VIAL') || saleUnit.includes('AMP') || saleUnit.includes('INJ')) return 'vials';
  if (saleUnit.includes('PACK') || saleUnit.includes('BOX') || saleUnit.includes('KIT') || saleUnit.includes('POUCH') || saleUnit.includes('BAG') || saleUnit.includes('CARTON')) return 'packs';
  if (saleUnit.includes('PIECE') || saleUnit.includes('PCS')) return 'pcs';

  const desc = String(line.raw_description || '').toUpperCase();
  const pack = String(line.pack_raw || '').toUpperCase().trim();
  const text = `${desc} ${pack}`;

  // 2. Specific product forms & containers
  if (/\b(INJ|INJECTION|VIAL|VIALS|AMP|AMPOULE|AMPOULES|IV|INFUSION|PEN|CARTRIDGE)\b/.test(text)) {
    return 'vials';
  }

  if (/\b(SOAP|DEVICE|BANDAGE|COTTON|GAUZE|MASK|GLOVES|NEEDLE|SYRINGE|THERMOMETER|WIPES|BRUSH|CONDOM|DIAPER|PAD|PADS|PIECE|PCS)\b/.test(text)) {
    return 'pcs';
  }

  if (/\b(OINT|OINTMENT|CREAM|GEL|JELLY|PASTE|BALM|LINIMENT|EMULGEL)\b/.test(text)) {
    return 'tubes';
  }

  if (/\b(TAB|TABS|TABLET|TABLETS|CAP|CAPS|CAPSULE|CAPSULES|STRIP|STRIPS|BLISTER)\b/.test(text) || /^\d+('S|S|T|C)$/.test(pack)) {
    return 'strips';
  }

  if (/\b(SYRUP|SUSP|SUSPENSION|SOL|SOLUTION|LOTION|ELIXIR|DROPS|DROP|EYE DROP|EAR DROP|NASAL DROP|TONIC|DUSTING POWDER|JAR|TIN|CAN)\b/.test(text)) {
    return 'bottles';
  }

  if (/\b(MALT|RAGI|FOOD|CEREAL|DRINK|HEALTH DRINK|NUTRITION|SUPPLEMENT|GRANULES|SACHET|SACHETS|POUCH|BOX|BAG|CARTON|INHALER|ROTACAP|RESPULES|SPRAY|KIT|COMBIPACK|PACK|PATCH)\b/.test(text)) {
    return 'packs';
  }

  // 3. Packaging suffixes
  if (/\b\d+(\.\d+)?\s*(ML|L|LTR|LTRS)\b/.test(pack)) {
    return 'bottles';
  }

  if (/\b\d+(\.\d+)?\s*(GM|GMS|G|KG)\b/.test(pack)) {
    if (/\b(POWDER|DUSTING|JAR|TIN)\b/.test(text)) return 'bottles';
    if (/\b(MALT|FOOD|DRINK|CEREAL|NUTRITION|GRANULES|SACHET|REFILL|PACK|BOX)\b/.test(text)) return 'packs';
    const num = parseFloat(pack);
    if (Number.isFinite(num) && num >= 100) return 'packs';
    return 'tubes';
  }

  // Default fallback
  return 'strips';
}

/**
 * Resolves the dispensing unit representation for display and form prefilling.
 * Distinguishes whether the unit was explicitly extracted (line.sale_unit) or inferred.
 */
export function resolveDispensingUnit(line) {
  const inferred = inferUnit(line);
  if (line?.sale_unit) {
    return {
      unit: inferred,
      label: String(line.sale_unit).toUpperCase(),
      isExplicit: true,
    };
  }
  return {
    unit: inferred,
    label: inferred.toUpperCase().replace(/S$/, ''),
    isExplicit: false,
  };
}

/**
 * Formats what a single pack holds (e.g. "10 tablets", "100 ML", "7 × 2 ML").
 * Returns null if no pack content is detected or confidently available.
 */
export function formatPackContent(line) {
  if (!line) return null;

  // Nested pack: e.g. 7X2ML -> 7 × 2 ML
  if (line.sub_pack_quantity && line.content_quantity && line.content_unit) {
    return `${line.sub_pack_quantity} × ${line.content_quantity} ${line.content_unit}`;
  }

  if (line.content_quantity && line.content_unit) {
    const qty = line.content_quantity;
    const unit = String(line.content_unit).toUpperCase();

    if (unit === 'PIECE') {
      const desc = String(line.raw_description || '').toUpperCase();
      if (/\b(TAB|TABS|TABLET|TABLETS)\b/.test(desc)) return `${qty} tablets`;
      if (/\b(CAP|CAPS|CAPSULE|CAPSULES)\b/.test(desc)) return `${qty} capsules`;
      return `${qty} pieces`;
    }
    if (unit === 'TABLET') return `${qty} tablets`;
    if (unit === 'CAPSULE') return `${qty} capsules`;
    if (unit === 'DOSE') return `${qty} doses`;

    return `${qty} ${unit}`;
  }

  return null;
}

/**
 * Infers initial values for catalogue pack content configuration (pack_content_quantity & pack_content_unit).
 * Returns { quantity: string, unit: string } suitable for Form state.
 */
export function inferPackContents(line) {
  if (!line || line.content_quantity == null) return { quantity: '', unit: '' };

  const qtyNum = Number(line.content_quantity);
  if (!Number.isFinite(qtyNum) || qtyNum < 1 || qtyNum > 1000) {
    return { quantity: '', unit: '' };
  }

  let unit = String(line.content_unit || '').toUpperCase();
  if (unit === 'PIECE') {
    const desc = String(line.raw_description || '').toUpperCase();
    if (/\b(TAB|TABS|TABLET|TABLETS)\b/.test(desc)) unit = 'TABLET';
    else if (/\b(CAP|CAPS|CAPSULE|CAPSULES)\b/.test(desc)) unit = 'CAPSULE';
    else unit = 'PIECE';
  }

  const VALID_CONTENT_UNITS = ['TABLET', 'CAPSULE', 'PIECE', 'MCG', 'MG', 'KG', 'GM', 'ML', 'L', 'DOSE', 'IU'];
  if (!VALID_CONTENT_UNITS.includes(unit)) {
    return { quantity: '', unit: '' };
  }

  // A pack of 1 countable unit is already a single unit; leave blank to avoid validation error
  if (qtyNum === 1 && ['TABLET', 'CAPSULE', 'PIECE'].includes(unit)) {
    return { quantity: '', unit: '' };
  }

  return {
    quantity: String(qtyNum),
    unit,
  };
}

