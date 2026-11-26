import { readFileSync } from "node:fs";

// Changes from 1 March. They are kept here, so config/legacy.json is not edited.
const table = {
  ...JSON.parse(readFileSync(new URL("../config/legacy.json", import.meta.url), "utf8")).countries,
  NL: "eu-central",
  AT: "eu-central",
  MX: "us-east",
};

// Every unknown country code that regionOf got, in the order received (for the support team).
export const unknownCodes = [];

// The region of a country code such as "DE", or null.
// Surrounding spaces and letter case are ignored, so " de " finds "DE".
// An unknown code is recorded in unknownCodes and gives null.
export function regionOf(code) {
  const key = String(code).trim().toUpperCase();
  const region = table[key] ?? null;
  if (region === null) unknownCodes.push(key);
  return region;
}

// The country code in an address line: the part after the last comma, in capitals, without spaces.
// "Hauptstr. 1, 10115 Berlin, de" gives "DE".
export function countryOf(addressLine) {
  const parts = String(addressLine).split(",");
  return parts[parts.length - 1].trim().toUpperCase();
}

// The postcode rules per country: DE 5 digits, NL "1012 AB", US 5 digits or 5 digits, a dash and 4 digits.
const POSTCODE_RULES = {
  DE: /^\d{5}$/,
  NL: /^\d{4} [A-Z]{2}$/,
  US: /^\d{5}(-\d{4})?$/,
};

// True if the postcode fits the rules of the country. Other countries give false.
// The country code is handled as in regionOf (spaces and letter case are ignored). Unknown codes are not recorded.
export function validPostcode(countryCode, postcode) {
  const rule = POSTCODE_RULES[String(countryCode).trim().toUpperCase()];
  return rule ? rule.test(String(postcode)) : false;
}

// True only for Germany ("DE"). Spaces and letter case are ignored, as in regionOf.
export function isDomestic(code) {
  return String(code).trim().toUpperCase() === "DE";
}

// A label for shop pages: the first part in capitals, each other part capitalized.
// "eu-central" gives "EU Central", and "ap-north" gives "AP North".
export function regionLabel(region) {
  return String(region)
    .split("-")
    .map((part, i) => (i === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

// The codes of all countries of a region, sorted from A to Z.
export function countriesIn(region) {
  return Object.keys(table)
    .filter((code) => table[code] === region)
    .sort();
}
