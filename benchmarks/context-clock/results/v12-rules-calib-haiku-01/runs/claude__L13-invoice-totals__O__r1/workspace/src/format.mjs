// "1,234.56" from 123456 cents; "-1,234.56" for negative amounts.
export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

// "12.34 EUR" from 1234 cents and a currency code.
export function formatMoney(cents, currency) {
  return `${formatCents(cents)} ${currency}`;
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

// Words for an integer from 0 to 999, e.g. 101 -> "one hundred one", 34 -> "thirty-four".
function wordsUpTo999(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
  if (rest > 0 || hundreds === 0) {
    if (rest < 20) {
      parts.push(ONES[rest]);
    } else {
      const tens = TENS[Math.floor(rest / 10)];
      const unit = rest % 10;
      parts.push(unit ? `${tens}-${ONES[unit]}` : tens);
    }
  }
  return parts.join(" ");
}

// Amount in words for checks, from 0 to 99999 cents:
// 1234 -> "twelve euros and thirty-four cents". Throws a RangeError outside that range.
export function amountInWords(cents) {
  if (!Number.isInteger(cents) || cents < 0 || cents > 99999) {
    throw new RangeError(`Amount out of range: ${cents}`);
  }
  const euros = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${wordsUpTo999(euros)} euros and ${wordsUpTo999(rest)} cents`;
}

// Cents from text in the form formatCents writes: "1,234.50" -> 123450, "-3.10" -> -310.
// Throws a TypeError for any other text.
export function parseCents(text) {
  const match = /^(-?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());
  if (!match) throw new TypeError(`Invalid amount: ${text}`);
  const [, sign, digits, fraction = ""] = match;
  const whole = Number(digits.replace(/,/g, ""));
  const frac = Number(fraction.padEnd(2, "0"));
  const cents = whole * 100 + frac;
  return sign === "-" && cents !== 0 ? -cents : cents;
}
