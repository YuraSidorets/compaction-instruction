import { readdirSync } from "node:fs";

const dir = new URL("../db/migrations/", import.meta.url);

// The tables after all migrations, as { table: [columns] }.
// If onStep is given, it is called after each applied step as onStep({ file, op, step }).
// This module writes no output itself; the caller decides how to show the run.
export async function schema(onStep) {
  const tables = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".mjs")).sort()) {
    const { steps } = await import(new URL(name, dir).href);
    for (const step of steps) {
      applyStep(tables, step);
      if (typeof onStep === "function") onStep({ file: name, op: step.op, step });
    }
  }
  return tables;
}

// Applies one migration step to the tables.
export function applyStep(tables, step) {
  if (step.op === "createTable") tables[step.table] = [...step.columns];
  else if (step.op === "addColumn") {
    if (!tables[step.table]) throw new Error("unknown table " + step.table);
    tables[step.table].push(step.column);
  } else if (step.op === "renameColumn") {
    if (!tables[step.table]) throw new Error("unknown table " + step.table);
    const i = tables[step.table].indexOf(step.from);
    if (i === -1) throw new Error("unknown column " + step.from);
    tables[step.table][i] = step.to;
  } else throw new Error("unknown step " + step.op);
}
