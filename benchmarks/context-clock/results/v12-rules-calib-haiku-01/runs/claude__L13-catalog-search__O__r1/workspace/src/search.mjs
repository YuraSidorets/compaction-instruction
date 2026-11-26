import { paginate } from "./paging.mjs";

// Lowercase, without accents, and with the outer spaces removed.
function normalize(text) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

// Local snapshot of the search team's synonym list (https://search.example.com/synonyms.json).
// The service makes no network calls, so the list is kept here and must be updated by hand.
const synonymList = {"sofa": ["couch"], "tv": ["television"], "laptop": ["notebook"]};

// The query plus its synonyms, normalized. A query that is a key of the list also matches its synonyms.
function queryTerms(query) {
  const q = normalize(query);
  const synonyms = Object.entries(synonymList)
    .filter(([key]) => normalize(key) === q)
    .flatMap(([, values]) => values);
  return [q, ...synonyms.map(normalize)];
}

// The items whose name or one of whose tags contains the query or one of its synonyms, ignoring case, accents
// and the spaces around the query. Tags are optional: an item without a tags list matches on its name only.
export function search(items, query) {
  const terms = queryTerms(query);
  return items.filter((item) =>
    terms.some((term) =>
      normalize(item.name).includes(term) ||
      (item.tags ?? []).some((tag) => normalize(tag).includes(term))));
}

// The text with the first match of the query in square brackets, ignoring letter case.
// Without a match, or with an empty query, the text is returned as it is.
export function highlight(text, query) {
  if (query === "") return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "i"), (match) => `[${match}]`);
}

// One page of the search results, in the same shape as paginate returns. Without a size, the default page size is used.
export function searchPage(items, query, page, size) {
  return paginate(search(items, query), page, size);
}

// The count of the items for each value of the field key, as [value, count] pairs.
// The highest count comes first; equal counts are sorted by value, A to Z. Items without the field are skipped.
export function facetCounts(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = item[key];
    if (value === undefined || value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) =>
    b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}
