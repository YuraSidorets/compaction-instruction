import { roundCents } from "../vendor/money-round.mjs";

// Rounds half cents away from zero: 250.5 -> 251, -250.5 -> -251.
// roundCents rounds half up only, so the absolute value is rounded and the sign restored.
function roundHalfAwayFromZero(x) {
  const r = roundCents(Math.abs(x));
  return x < 0 && r !== 0 ? -r : r;
}

// One invoice line: { qty, unitCents, discountPct? }.
// discountPct is a percentage from 0 to 100; a missing field means no discount.
// The discount is applied before rounding.
export function lineTotal(line) {
  const discountPct = line.discountPct ?? 0;
  return roundHalfAwayFromZero((line.qty * line.unitCents * (100 - discountPct)) / 100);
}

// The sum of all lines, in cents. Lines with qty 0 or less (cancelled items) are skipped.
export function invoiceTotal(lines) {
  let sum = 0;
  for (const line of lines) {
    if (line.qty <= 0) continue;
    sum += lineTotal(line);
  }
  return sum;
}

// The subtotal of the lines, in cents: the sum without tax. Same as invoiceTotal.
export function subtotal(lines) {
  return invoiceTotal(lines);
}

// Merges lines with the same sku: quantities are added, other fields come from the first line
// with that sku. The order follows the first line of each sku. The input is not changed.
export function mergeLines(lines) {
  const bySku = new Map();
  for (const line of lines) {
    const existing = bySku.get(line.sku);
    if (existing) {
      existing.qty += line.qty;
    } else {
      bySku.set(line.sku, { ...line });
    }
  }
  return [...bySku.values()];
}

// The default tax rate of the deployment, in percent. 20 until the operations team sets another.
let defaultTaxRatePct = 20;

// Sets the default tax rate of this deployment (percent, 0 or more). Called once at service start.
export function setDefaultTaxRate(ratePct) {
  if (typeof ratePct !== "number" || !Number.isFinite(ratePct) || ratePct < 0) {
    throw new TypeError(`Invalid tax rate: ${ratePct}`);
  }
  defaultTaxRatePct = ratePct;
}

// The current default tax rate of this deployment, in percent.
export function getDefaultTaxRate() {
  return defaultTaxRatePct;
}

// The tax of the invoice, in cents: invoiceTotal(lines) * ratePct / 100, rounded.
// Without ratePct, the default tax rate of the deployment is used.
export function invoiceTax(lines, ratePct = defaultTaxRatePct) {
  return roundHalfAwayFromZero((invoiceTotal(lines) * ratePct) / 100);
}

// The invoice summary, in cents: { net, tax, gross }, where net is invoiceTotal,
// tax is invoiceTax, and gross is net + tax. Without ratePct, the default rate is used.
export function invoiceSummary(lines, ratePct = defaultTaxRatePct) {
  const net = invoiceTotal(lines);
  const tax = invoiceTax(lines, ratePct);
  return { net, tax, gross: net + tax };
}
