// Searches that a rule repeats from every opening marker, answered from a table built in one pass, so a
// document of thousands of unclosed markers doesn't search to its end from each one.

// For each index of `s`, the first index at or after it where test(s, i) holds, or -1.
export function nextWhere(s, test) {
  const next = new Int32Array(s.length + 1);
  next[s.length] = -1;
  for (let i = s.length - 1; i >= 0; i--) next[i] = test(s, i) ? i : next[i + 1];
  return next;
}

// The first index at or after `from` in a parser state's source where `test` holds, or -1. Each test's
// table is built the first time a rule needs it and kept with the state.
export function first(state, test, from) {
  const tables = (state.md2pdfScan ??= new Map());
  let next = tables.get(test);
  if (!next) tables.set(test, (next = nextWhere(state.src, test)));
  return from < next.length ? next[from] : -1;
}
