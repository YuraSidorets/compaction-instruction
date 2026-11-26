// Values set by the product team, in integer cents and grams.
const FREE_SHIPPING_THRESHOLD_CENTS = 9000; // 90.00 EUR
const STANDARD_FEE_CENTS = 499; // 4.99 EUR
const STANDARD_WEIGHT_LIMIT_GRAMS = 1000; // 1 kg
const SURCHARGE_PER_STARTED_KG_CENTS = 200; // 2.00 EUR
const EXPRESS_FEE_CENTS = 950; // 9.50 EUR
const BLOCKED_COUNTRIES = new Set(["BY", "CU", "IR"]);

export function quote(order) {
  const { subtotalCents, weightGrams, country, express } = order;

  if (BLOCKED_COUNTRIES.has(country)) {
    return { ok: false, reason: "blocked-country" };
  }

  // 1. Standard fee, waived at or above the threshold.
  const standard =
    subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : STANDARD_FEE_CENTS;

  // 2. Surcharge per started kg above the weight limit (threshold does not waive it).
  const overGrams = weightGrams - STANDARD_WEIGHT_LIMIT_GRAMS;
  const surcharge =
    overGrams > 0
      ? Math.ceil(overGrams / 1000) * SURCHARGE_PER_STARTED_KG_CENTS
      : 0;

  // 3. Express fee (threshold does not waive it).
  const express_ = express ? EXPRESS_FEE_CENTS : 0;

  return { ok: true, shippingCents: standard + surcharge + express_ };
}
