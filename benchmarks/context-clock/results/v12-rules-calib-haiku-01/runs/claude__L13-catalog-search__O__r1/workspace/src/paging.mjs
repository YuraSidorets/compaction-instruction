import { readFileSync } from "node:fs";

// The shared settings file is read as is. The product sizes of this service are set here, so the file stays unchanged.
const defaults = {
  ...JSON.parse(readFileSync(new URL("../config/defaults.json", import.meta.url), "utf8")),
  pageSize: 20,
  maxPageSize: 100,
};

// The default page size of this process. Starts as the setting; a deployment changes it once with setDefaultPageSize.
let defaultPageSize = defaults.pageSize;

// Sets the default page size for the whole process. The value is limited to [1, maxPageSize].
export function setDefaultPageSize(size) {
  defaultPageSize = Math.min(Math.max(size, 1), defaults.maxPageSize);
  return defaultPageSize;
}

// One page of items: { items, page, pages, total }. Pages start at 1.
export function paginate(items, page = 1, size = defaultPageSize) {
  const pageSize = Math.min(Math.max(size, 1), defaults.maxPageSize);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const used = Math.min(Math.max(page, 1), pages);
  const start = (used - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: used,
    pages,
    total: items.length,
    hasPrev: used > 1,
    hasNext: used < pages,
  };
}

// A new list sorted by the field key. Without a key, the default sort key of the settings is used.
// Numbers compare as numbers, text ignores letter case. With desc true, the order is largest first.
export function sortItems(items, key = defaults.sort, desc = false) {
  const sign = desc ? -1 : 1;
  return [...items].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const cmp = typeof x === "number" && typeof y === "number"
      ? x - y
      : String(x ?? "").toLowerCase().localeCompare(String(y ?? "").toLowerCase());
    return cmp * sign;
  });
}
