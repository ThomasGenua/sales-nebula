export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const src = String(text).replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v !== "")) rows.push(row);
  const [header = [], ...body] = rows;
  if (quoted) throw new Error("A quoted CSV field was not closed");
  if (header.some(h => !h.trim()) || new Set(header.map(h => h.trim())).size !== header.length) throw new Error("Every column needs a unique, non-empty heading");
  if (body.some(r => r.length !== header.length)) throw new Error("Each row must have the same number of columns as the headings");
  return { header: header.map(h => h.trim()), rows: body.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()]))) };
}
