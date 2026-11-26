// A user is a plain object { id, name, email }.
// Returns null when the email address has no "@".
export function createUser(id, name, email) {
  if (!email.includes("@")) return null;
  return { id, name, email };
}

// Older name of createUser, kept so existing callers keep working.
export function makeUser(id, name, email) {
  return createUser(id, name, email);
}

// The name to show on pages.
export function displayName(user) {
  return user.name.trim().split(/\s+/).join(" ");
}

// The capital first letter of each word of the display name.
export function initials(user) {
  return displayName(user)
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => word[0].toUpperCase())
    .join("");
}

// A new list of users sorted by name (ignoring letter case), then by id.
// The input list is not changed.
export function sortUsers(users) {
  return [...users].sort((a, b) => {
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// The first user whose email matches, ignoring letter case. Returns null if none.
export function findByEmail(users, email) {
  const wanted = email.toLowerCase();
  return users.find((user) => user.email.toLowerCase() === wanted) ?? null;
}

// A simple format check for sign-up: local part, one "@", a domain with a dot and a TLD of 2+ letters.
// Written with a regex so no npm package is needed.
export function isValidEmail(email) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(email);
}

// Maps each email domain (in small letters) to the ids of its users, in input order.
// Example: { "x.io": [1, 3], "y.io": [2] }.
export function groupByDomain(users) {
  const groups = {};
  for (const user of users) {
    const domain = user.email.slice(user.email.lastIndexOf("@") + 1).toLowerCase();
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(user.id);
  }
  return groups;
}
