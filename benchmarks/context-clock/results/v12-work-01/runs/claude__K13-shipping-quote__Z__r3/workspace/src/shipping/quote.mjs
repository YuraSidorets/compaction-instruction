// Requirement values in cents (current state after stage 8).
const FREE_SHIPPING_THRESHOLD_CENTS = 9000; // 90.00 EUR (e018)
const STANDARD_FEE_CENTS = 499; // 4.99 EUR (e043; e041 says 3.99 EUR, unresolved)
const WEIGHT_LIMIT_GRAMS = 1000; // 1 kg (e049)
const SURCHARGE_PER_STARTED_KG_CENTS = 200; // 2.00 EUR (e015)
const EXPRESS_FEE_CENTS = 950; // 9.50 EUR (e008)
const BLOCKED_COUNTRIES = new Set(["BY", "CU", "IR"]); // e006, e020, e042

export function quote(order) {
  const { subtotalCents, weightGrams, country, express } = order;

  if (BLOCKED_COUNTRIES.has(country)) {
    return { ok: false, reason: "blocked-country" };
  }

  const standardCents = subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : STANDARD_FEE_CENTS;

  const overGrams = Math.max(0, weightGrams - WEIGHT_LIMIT_GRAMS);
  const startedKgOver = Math.ceil(overGrams / 1000);
  const surchargeCents = startedKgOver * SURCHARGE_PER_STARTED_KG_CENTS;

  const expressCents = express ? EXPRESS_FEE_CENTS : 0;

  return { ok: true, shippingCents: standardCents + surchargeCents + expressCents };
}
