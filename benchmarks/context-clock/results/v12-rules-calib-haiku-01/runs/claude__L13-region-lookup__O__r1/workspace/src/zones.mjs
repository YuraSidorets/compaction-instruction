import { regionOf } from "./regions.mjs";

// The shipping zone of a region: 1 for the home regions, 3 for ap-north, 2 for the others.
export function zoneOf(region) {
  if (region === "eu-central" || region === "eu-west") return 1;
  if (region === "ap-north") return 3;
  return 2;
}

// The shipping zone of a country code, or null for an unknown country.
export function shippingZone(code) {
  const region = regionOf(code);
  return region === null ? null : zoneOf(region);
}

// The shipping cost in euros for a country code and a weight in kg (rounded up), or null for an unknown country.
// Zone 1: 5 plus 1 per kg. Zone 2: 12 plus 2 per kg. Zone 3: 20 plus 3 per kg.
const RATES = { 1: [5, 1], 2: [12, 2], 3: [20, 3] };

// Fuel surcharge in percent per zone, copied from the finance file (no network calls allowed).
// The finance team changes these every quarter, so update them here by hand.
const FUEL_PERCENT = { 1: 4, 2: 7.5, 3: 11 };

// The cost including the fuel surcharge of the zone, rounded to whole cents.
export function shippingCost(code, weightKg) {
  const zone = shippingZone(code);
  if (zone === null) return null;
  const [base, perKg] = RATES[zone];
  const cost = base + perKg * Math.ceil(weightKg);
  return Math.round(cost * (1 + FUEL_PERCENT[zone] / 100) * 100) / 100;
}
