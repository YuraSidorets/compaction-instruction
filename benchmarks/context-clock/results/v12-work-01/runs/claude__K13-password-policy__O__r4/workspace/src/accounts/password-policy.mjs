// Requirement values set by the security team (final state after all stages).
const MIN_LENGTH = 10;
const MAX_LENGTH = 24;
const NEEDS_DIGIT = true;
const NEEDS_UPPER = true;
const NEEDS_SYMBOL = true;
const USERNAME_RULE = true;
const BANNED_WORDS = ["monkey", "welcome", "sunshine", "secret"];

export function checkPassword(password, context = {}) {
  const broken = [];
  const length = [...password].length;

  if (length < MIN_LENGTH) broken.push("too-short");
  if (length > MAX_LENGTH) broken.push("too-long");
  if (NEEDS_DIGIT && !/[0-9]/.test(password)) broken.push("needs-digit");
  if (NEEDS_UPPER && !/[A-Z]/.test(password)) broken.push("needs-upper");
  if (NEEDS_SYMBOL && !/[^A-Za-z0-9]/.test(password)) broken.push("needs-symbol");

  const lower = password.toLowerCase();
  const username = context?.username;
  if (USERNAME_RULE && typeof username === "string" && [...username].length >= 3) {
    if (lower.includes(username.toLowerCase())) broken.push("contains-username");
  }

  if (BANNED_WORDS.some((word) => lower.includes(word))) broken.push("banned-word");

  return broken.sort();
}
