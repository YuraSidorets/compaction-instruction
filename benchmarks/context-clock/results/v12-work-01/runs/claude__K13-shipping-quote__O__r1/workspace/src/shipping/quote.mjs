// Amounts are in cents, weights in grams.
const FREE_SHIPPING_THRESHOLD_CENTS = 9000; // 90.00 EUR
const STANDARD_FEE_CENTS = 499; // 4.99 EUR
const WEIGHT_LIMIT_GRAMS = 1000; // 1 kg
const SURCHARGE_PER_KG_CENTS = 200; // 2.00 EUR per started kg
const EXPRESS_FEE_CENTS = 950; // 9.50 EUR
const BLOCKED_COUNTRIES = new Set(["BY", "CU", "IR"]);

export function quote(order) {
  if (BLOCKED_COUNTRIES.has(order.country)) {
    return { ok: false, reason: "blocked-country" };
  }

  const standardFee =
    order.subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : STANDARD_FEE_CENTS;

  const excessGrams = order.weightGrams - WEIGHT_LIMIT_GRAMS;
  const surcharge =
    excessGrams > 0
      ? Math.ceil(excessGrams / 1000) * SURCHARGE_PER_KG_CENTS
      : 0;

  const expressFee = order.express ? EXPRESS_FEE_CENTS : 0;

  return { ok: true, shippingCents: standardFee + surcharge + expressFee };
}
