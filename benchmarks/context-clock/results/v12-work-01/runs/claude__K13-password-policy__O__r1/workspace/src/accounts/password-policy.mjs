// Password policy. Requirement values are set by the security team.
const MIN_LENGTH = 10;
const MAX_LENGTH = 24;
const NEEDS_DIGIT = true;
const NEEDS_UPPER = true;
const NEEDS_SYMBOL = true;
const USERNAME_RULE_ON = true;
const USERNAME_MIN_LENGTH = 3;
const BANNED_WORDS = ["monkey", "welcome", "sunshine", "secret"];

export function checkPassword(password, context = {}) {
  const text = String(password ?? "");
  const username = context?.username;
  const lower = text.toLowerCase();
  const broken = [];

  // Count characters, not UTF-16 code units.
  const length = [...text].length;
  if (length < MIN_LENGTH) broken.push("too-short");
  if (length > MAX_LENGTH) broken.push("too-long");

  if (NEEDS_DIGIT && !/[0-9]/.test(text)) broken.push("needs-digit");
  if (NEEDS_UPPER && !/[A-Z]/.test(text)) broken.push("needs-upper");
  if (NEEDS_SYMBOL && !/[^A-Za-z0-9]/.test(text)) broken.push("needs-symbol");

  if (
    USERNAME_RULE_ON &&
    typeof username === "string" &&
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
