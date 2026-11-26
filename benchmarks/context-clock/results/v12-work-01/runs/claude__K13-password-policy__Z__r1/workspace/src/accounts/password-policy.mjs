// Password policy for the customer account service.
// Current requirement values (see src/accounts/README.md for the rule codes).
const MIN_LENGTH = 10;
const MAX_LENGTH = 24;
const REQUIRE_DIGIT = true;
const REQUIRE_UPPER = true;
const REQUIRE_SYMBOL = true;
const USERNAME_RULE_ON = true;
const USERNAME_MIN_LENGTH = 3;
const BANNED_WORDS = ["monkey", "welcome", "sunshine", "secret"];

export function checkPassword(password, context = {}) {
  const broken = [];
  const text = String(password ?? "");

  if (text.length < MIN_LENGTH) broken.push("too-short");
  if (text.length > MAX_LENGTH) broken.push("too-long");

  if (REQUIRE_DIGIT && !/[0-9]/.test(text)) broken.push("needs-digit");
  if (REQUIRE_UPPER && !/[A-Z]/.test(text)) broken.push("needs-upper");
  if (REQUIRE_SYMBOL && !/[^A-Za-z0-9]/.test(text)) broken.push("needs-symbol");

  const lower = text.toLowerCase();
  const username = typeof context?.username === "string" ? context.username : "";
  if (
    USERNAME_RULE_ON &&
    username.length >= USERNAME_MIN_LENGTH &&
    lower.includes(username.toLowerCase())
  ) {
    broken.push("contains-username");
  }

  if (BANNED_WORDS.some((word) => lower.includes(word))) {
    broken.push("banned-word");
  }

  return broken.sort();
}
