// Password policy. Requirements in force after stage 8.
const MIN_LENGTH = 10;
const MAX_LENGTH = 24;
const NEEDS_DIGIT = true;
const NEEDS_UPPER = true;
const NEEDS_SYMBOL = true;
const USERNAME_RULE = true;
const BANNED_WORDS = ["monkey", "secret", "sunshine", "welcome"];

export function checkPassword(password, context = {}) {
  const codes = [];
  const length = [...password].length;

  if (length < MIN_LENGTH) codes.push("too-short");
  if (length > MAX_LENGTH) codes.push("too-long");
  if (NEEDS_DIGIT && !/[0-9]/.test(password)) codes.push("needs-digit");
  if (NEEDS_UPPER && !/[A-Z]/.test(password)) codes.push("needs-upper");
  if (NEEDS_SYMBOL && !/[^A-Za-z0-9]/u.test(password)) codes.push("needs-symbol");

  const username = context?.username;
  if (
    USERNAME_RULE &&
    typeof username === "string" &&
    [...username].length >= 3 &&
    password.toLowerCase().includes(username.toLowerCase())
  ) {
    codes.push("contains-username");
  }

  const lower = password.toLowerCase();
  if (BANNED_WORDS.some((word) => lower.includes(word))) codes.push("banned-word");

  return codes.sort();
}
