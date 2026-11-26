// Parses simple CSV text: the first line has the column names, and fields are separated by commas.
export function parseCsv(text) {
  // Reads the text one character at a time. A double quote starts a quoted field, where commas are
  // part of the value; two double quotes inside a quoted field stand for one double quote.
  // Both "\n" and "\r\n" end a record, and empty lines are skipped.
  const records = [];
  let cells = [];
  let cell = "";
  let inQuotes = false;
  let quoted = false; // the current record has a quoted field
  const endRecord = () => {
    cells.push(cell);
    if (cells.length > 1 || cell.trim() !== "" || quoted) records.push(cells);
    cells = [];
    cell = "";
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r" && text[i + 1] === "\n") {
      i++;
      endRecord();
    } else {
      cell += ch;
    }
  }
  if (cells.length > 0 || cell !== "" || quoted) endRecord();
  if (records.length === 0) return [];
  const head = records[0];
  // A cell such as "12", "-2" or "1.25" becomes a number; other cells stay text.
  const asValue = (cell) => (/^-?\d+(\.\d+)?$/.test(cell) ? Number(cell) : cell);
  return records.slice(1).map((fields) => {
    const row = {};
    head.forEach((h, i) => (row[h] = asValue(fields[i])));
    return row;
  });
}

// The rows whose cell in the column equals the value, compared as text.
export function filterRows(rows, column, value) {
  return rows.filter((r) => String(r[column] ?? "") === String(value));
}

// A new list of the rows, sorted by the column. Cells that hold numbers compare as numbers;
// other cells compare as text, by character code. With desc true, the order is largest to smallest.
export function sortRows(rows, column, desc) {
  const toNumber = (r) => {
    const text = String(r[column] ?? "").trim();
    if (text === "") return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  };
  const sign = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na !== null && nb !== null) return sign * (na - nb);
    const ta = String(a[column] ?? "");
    const tb = String(b[column] ?? "");
    return sign * (ta < tb ? -1 : ta > tb ? 1 : 0);
  });
}

// An object with the sum of the value column for each value of the key column.
// Value cells that are not numbers count as 0.
export function groupSum(rows, keyColumn, valueColumn) {
  const totals = {};
  for (const r of rows) {
    const key = String(r[keyColumn] ?? "");
    const text = String(r[valueColumn] ?? "").trim();
    const n = text === "" ? NaN : Number(text);
    const add = Number.isFinite(n) ? n : 0;
    const current = Object.hasOwn(totals, key) ? totals[key] : 0;
    // defineProperty keeps keys such as "__proto__" as ordinary keys.
    Object.defineProperty(totals, key, {
      value: current + add,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return totals;
}

// The sum of a column of numbers. Empty cells and cells that are not numbers are skipped.
export function columnSum(rows, column) {
  return rows.reduce((a, r) => {
    const text = String(r[column] ?? "").trim();
    if (text === "") return a;
    const n = Number(text);
    return Number.isNaN(n) ? a : a + n;
  }, 0);
}

// The average of the cells that are numbers, rounded to 2 decimals. Other cells are skipped.
// Returns null when the column has no number.
export function columnAverage(rows, column) {
  let total = 0;
  let count = 0;
  for (const r of rows) {
    const text = String(r[column] ?? "").trim();
    if (text === "") continue;
    const n = Number(text);
    if (!Number.isFinite(n)) continue;
    total += n;
    count++;
  }
  if (count === 0) return null;
  return Math.round((total / count) * 100) / 100;
}
