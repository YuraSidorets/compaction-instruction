// Current requirements (all amounts in cents, weights in grams).
const BLOCKED_COUNTRIES = ["BY", "CU", "IR"];
const FREE_SHIPPING_THRESHOLD_CENTS = 9000; // 90.00 EUR
const STANDARD_FEE_CENTS = 499; // 4.99 EUR
const STANDARD_WEIGHT_LIMIT_GRAMS = 1000; // 1 kg
const SURCHARGE_PER_STARTED_KG_CENTS = 200; // 2.00 EUR
const EXPRESS_FEE_CENTS = 950; // 9.50 EUR

export function quote(order) {
  const { subtotalCents, weightGrams, country, express } = order;

  if (BLOCKED_COUNTRIES.includes(country)) {
    return { ok: false, reason: "blocked-country" };
  }

  // 1. Standard fee, removed by the free shipping threshold.
  const standardCents =
    subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : STANDARD_FEE_CENTS;

  // 2. Surcharge per started kg above the weight limit. Not removed by the threshold.
  const excessGrams = weightGrams - STANDARD_WEIGHT_LIMIT_GRAMS;
  const surchargeCents =
    excessGrams > 0
      ? Math.ceil(excessGrams / 1000) * SURCHARGE_PER_STARTED_KG_CENTS
      : 0;

  // 3. Express fee. Not removed by the threshold.
  const expressCents = express ? EXPRESS_FEE_CENTS : 0;

  return { ok: true, shippingCents: standardCents + surchargeCents + expressCents };
}
