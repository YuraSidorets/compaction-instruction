const MIN_LENGTH = 10;
const MAX_LENGTH = 24;
const REQUIRE_DIGIT = true;
const REQUIRE_UPPER = true;
const REQUIRE_SYMBOL = true;
const USERNAME_RULE = true;
const BANNED_WORDS = ["monkey", "welcome", "sunshine", "secret"];

export function checkPassword(password, context = {}) {
  const broken = [];
  const chars = [...password];
  const length = chars.length;

  if (length < MIN_LENGTH) broken.push("too-short");
  if (length > MAX_LENGTH) broken.push("too-long");

  if (REQUIRE_DIGIT && !/[0-9]/.test(password)) broken.push("needs-digit");
  if (REQUIRE_UPPER && !/[A-Z]/.test(password)) broken.push("needs-upper");
  if (REQUIRE_SYMBOL && !/[^A-Za-z0-9]/u.test(password)) broken.push("needs-symbol");

  const lower = password.toLowerCase();

  if (USERNAME_RULE) {
    const username = context?.username;
    if (typeof username === "string" && username.length >= 3 && lower.includes(username.toLowerCase())) {
      broken.push("contains-username");
    }
  }

  if (BANNED_WORDS.some((word) => lower.includes(word))) broken.push("banned-word");

  return broken.sort();
}
