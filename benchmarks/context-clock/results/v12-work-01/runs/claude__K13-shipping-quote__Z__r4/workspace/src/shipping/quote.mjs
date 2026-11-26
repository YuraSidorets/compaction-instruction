// Shipping quote. All amounts are in cents.

const FREE_SHIPPING_THRESHOLD_CENTS = 9000; // 90.00 EUR
const STANDARD_FEE_CENTS = 499; // 4.99 EUR
const WEIGHT_LIMIT_GRAMS = 1000; // 1 kg
const SURCHARGE_PER_STARTED_KG_CENTS = 200; // 2.00 EUR
const EXPRESS_FEE_CENTS = 950; // 9.50 EUR
const BLOCKED_COUNTRIES = new Set(["BY", "CU", "IR"]);

export function quote(order) {
  const { subtotalCents, weightGrams, country, express } = order;

  if (BLOCKED_COUNTRIES.has(country)) {
    return { ok: false, reason: "blocked-country" };
  }

  const standardFee =
    subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : STANDARD_FEE_CENTS;

  const overLimitGrams = Math.max(0, weightGrams - WEIGHT_LIMIT_GRAMS);
  const startedKgOverLimit = Math.ceil(overLimitGrams / 1000);
  const weightSurcharge = startedKgOverLimit * SURCHARGE_PER_STARTED_KG_CENTS;

  const expressFee = express ? EXPRESS_FEE_CENTS : 0;

  return { ok: true, shippingCents: standardFee + weightSurcharge + expressFee };
}
