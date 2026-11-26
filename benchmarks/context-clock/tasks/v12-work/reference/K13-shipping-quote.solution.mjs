// Reference solution of K13-shipping-quote: the requirements after stage 8.
const REQUIREMENTS = {"freeThreshold":9000,"baseFee":499,"weightLimit":1000,"perKg":200,"expressFee":950,"blocked":["BY","CU","IR"]};

export function quote(order) {
  const P = REQUIREMENTS;
  if (P.blocked.includes(order.country)) return { ok: false, reason: "blocked-country" };
  const base = order.subtotalCents >= P.freeThreshold ? 0 : P.baseFee;
  const over = Math.max(0, order.weightGrams - P.weightLimit);
  const surcharge = Math.ceil(over / 1000) * P.perKg;
  const express = order.express ? P.expressFee : 0;
  return { ok: true, shippingCents: base + surcharge + express };
}
