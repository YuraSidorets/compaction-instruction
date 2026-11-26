// Values in integer cents and grams, as set by the product team (requirements after stage 8).
const FREE_SHIPPING_THRESHOLD_CENTS = 9000; // 90.00 EUR
const STANDARD_FEE_CENTS = 499; // 4.99 EUR
const WEIGHT_LIMIT_GRAMS = 1000; // 1 kg, weight limit for the standard fee
const SURCHARGE_PER_STARTED_KG_CENTS = 200; // 2.00 EUR
const EXPRESS_FEE_CENTS = 950; // 9.50 EUR
const BLOCKED_COUNTRIES = new Set(["BY", "CU", "IR"]);

export function quote(order) {
  const { subtotalCents, weightGrams, country, express } = order;

  if (BLOCKED_COUNTRIES.has(String(country).toUpperCase())) {
    return { ok: false, reason: "blocked-country" };
  }

  const standardFee =
    subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : STANDARD_FEE_CENTS;

  const gramsOver = Math.max(0, weightGrams - WEIGHT_LIMIT_GRAMS);
  const startedKgOver = Math.ceil(gramsOver / 1000);
  const weightSurcharge = startedKgOver * SURCHARGE_PER_STARTED_KG_CENTS;

  const expressFee = express ? EXPRESS_FEE_CENTS : 0;

  return { ok: true, shippingCents: standardFee + weightSurcharge + expressFee };
}
