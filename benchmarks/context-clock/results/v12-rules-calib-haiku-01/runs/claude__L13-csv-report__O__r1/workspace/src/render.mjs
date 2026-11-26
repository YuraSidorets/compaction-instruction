// A plain text table: a header line with the column names, a line of dashes as long as the header,
// then one line per row. The cells are separated by " | ". Each cell, the header included, is padded
// with spaces at the end to the width of the widest cell of its column.
// options.decimal sets the decimal separator for number cells; it is "." when not set.
// Text cells are not changed.
export function renderTable(rows, columns, options = {}) {
  const decimal = options.decimal ?? ".";
  const cellText = (v) =>
    typeof v === "number" ? String(v).split(".").join(decimal) : String(v);
  const cellsOf = (r) => columns.map((c) => cellText(r[c]));
  const body = rows.map(cellsOf);
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...body.map((cells) => cells[i].length))
  );
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join(" | ");
  const header = line(columns);
  const dashes = "-".repeat(header.length);
  return [header, dashes, ...body.map(line)].join("\n");
}

// CSV text for the export: a line with the column names, then one line per row, lines joined by "\n"
// with no line after the last one. A field with a comma, a double quote or a line break is put in
// double quotes, and each double quote inside it is written twice.
export function toCsv(rows, columns) {
  const field = (value) => {
    const text = String(value ?? "");
    if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  };
  const lines = [columns.map(field).join(",")];
  for (const r of rows) lines.push(columns.map((c) => field(r[c])).join(","));
  return lines.join("\n");
}
