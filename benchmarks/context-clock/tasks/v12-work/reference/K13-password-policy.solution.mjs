// Reference solution of K13-password-policy: the requirements after stage 8.
const REQUIREMENTS = {"minLength":10,"maxLength":24,"requireDigit":true,"requireUpper":true,"requireSymbol":true,"noUsername":true,"banned":["monkey","secret","sunshine","welcome"]};

export function checkPassword(password, context = {}) {
  const P = REQUIREMENTS;
  const out = [];
  if (password.length < P.minLength) out.push("too-short");
  if (password.length > P.maxLength) out.push("too-long");
  if (P.requireDigit && !/[0-9]/.test(password)) out.push("needs-digit");
  if (P.requireUpper && !/[A-Z]/.test(password)) out.push("needs-upper");
  if (P.requireSymbol && !/[^A-Za-z0-9]/.test(password)) out.push("needs-symbol");
  const lower = password.toLowerCase();
  const user = typeof context.username === "string" ? context.username.toLowerCase() : "";
  if (P.noUsername && user.length >= 3 && lower.includes(user)) out.push("contains-username");
  if (P.banned.some((w) => lower.includes(w))) out.push("banned-word");
  return out.sort();
}
