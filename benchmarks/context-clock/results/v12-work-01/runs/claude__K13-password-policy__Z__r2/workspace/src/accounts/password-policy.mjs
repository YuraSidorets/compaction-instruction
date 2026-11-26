// Password policy for the accounts module.
// Values are set by the security team (see README.md).

const MIN_LENGTH = 10;
const MAX_LENGTH = 24;
const DIGIT_REQUIRED = true;
const UPPER_REQUIRED = true;
const SYMBOL_REQUIRED = true;
const USERNAME_RULE_ON = true;
const BANNED_WORDS = ["monkey", "welcome", "sunshine", "secret"];

export function checkPassword(password, context = {}) {
  const broken = [];

  if (password.length < MIN_LENGTH) broken.push("too-short");
  if (password.length > MAX_LENGTH) broken.push("too-long");
  if (DIGIT_REQUIRED && !/[0-9]/.test(password)) broken.push("needs-digit");
  if (UPPER_REQUIRED && !/[A-Z]/.test(password)) broken.push("needs-upper");
  if (SYMBOL_REQUIRED && !/[^A-Za-z0-9]/.test(password)) broken.push("needs-symbol");

  const username = context?.username;
  if (
    USERNAME_RULE_ON &&
    typeof username === "string" &&
    username.length >= 3 &&
    password.toLowerCase().includes(username.toLowerCase())
  ) {
    broken.push("contains-username");
  }

  const lower = password.toLowerCase();
  if (BANNED_WORDS.some((word) => lower.includes(word))) broken.push("banned-word");

  return broken.sort();
}
