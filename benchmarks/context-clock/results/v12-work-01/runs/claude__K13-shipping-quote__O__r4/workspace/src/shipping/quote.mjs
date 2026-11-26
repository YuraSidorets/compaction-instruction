const FREE_SHIPPING_THRESHOLD_CENTS = 9000; // 90.00 EUR
const STANDARD_FEE_CENTS = 499; // 4.99 EUR
const STANDARD_WEIGHT_LIMIT_GRAMS = 1000; // 1 kg
const SURCHARGE_PER_STARTED_KG_CENTS = 200; // 2.00 EUR
const EXPRESS_FEE_CENTS = 950; // 9.50 EUR
const BLOCKED_COUNTRIES = new Set(["CU", "IR", "BY"]);

export function quote(order) {
  const { subtotalCents, weightGrams, country, express } = order;

  if (BLOCKED_COUNTRIES.has(country)) {
    return { ok: false, reason: "blocked-country" };
  }

  let shippingCents = 0;

  // 1. Standard fee, waived at or above the free shipping threshold.
  if (subtotalCents < FREE_SHIPPING_THRESHOLD_CENTS) {
    shippingCents += STANDARD_FEE_CENTS;
  }

  // 2. Surcharge per started kg above the weight limit (not removed by the threshold).
  const excessGrams = weightGrams - STANDARD_WEIGHT_LIMIT_GRAMS;
  if (excessGrams > 0) {
    const startedKg = Math.ceil(excessGrams / 1000);
    shippingCents += startedKg * SURCHARGE_PER_STARTED_KG_CENTS;
  }

  // 3. Express fee (not removed by the threshold).
  if (express === true) {
    shippingCents += EXPRESS_FEE_CENTS;
  }

  return { ok: true, shippingCents };
}
