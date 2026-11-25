// Stylesheet text handling for the CLI and the tests.

import { cssString } from './render.js';

// A comment, a string, an @import of a string, or a url(); the groups hold the @import's double- or
// single-quoted reference, then the url()'s double-quoted, single-quoted or bare one.
const STRING = (q) => `${q}(?:\\\\[^]|[^${q}\\\\\\n])*${q}`;
const TOKENS = new RegExp(
  String.raw`\/\*[^]*?\*\/|@import\s*(?:"((?:\\[^]|[^"\\\n])*)"|'((?:\\[^]|[^'\\\n])*)')|${STRING('"')}|${STRING("'")}|url\(\s*(?:"((?:\\[^]|[^"\\\n])*)"|'((?:\\[^]|[^'\\\n])*)'|([^)\s'"\\]*))\s*\)`,
  'gi',
);

// Replaces each relative url() and @import "…" in a stylesheet with url(<resolve(ref)>) or
// @import "<resolve(ref)>", leaving comments, strings, and references that are absolute, root-relative,
// fragments or contain CSS escapes as they are.
export function rewriteUrls(css, resolve) {
  return css.replace(TOKENS, (whole, idq, isq, dq, sq, bare) => {
    const ref = idq ?? isq ?? dq ?? sq ?? bare;
    if (!ref || ref.includes('\\') || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(ref)) return whole;
    return (idq ?? isq) !== undefined ? `@import ${cssString(resolve(ref))}` : `url(${cssString(resolve(ref))})`;
  });
}

// The relative references a stylesheet's url()s and @imports make, as rewriteUrls sees them.
export function relativeUrls(css) {
  const refs = [];
  rewriteUrls(css, (ref) => (refs.push(ref), ref));
  return refs;
}

// What may open a stylesheet: white space, a comment, or an @charset, @layer or @import statement.
// Each character of a statement can match only one way, and a comment ends at its first */, so a long
// statement that never ends can't make the match backtrack; an unclosed comment ends the opening.
const COMMENT = String.raw`\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/`;
const QUOTED = `${STRING('"')}|${STRING("'")}`;
const group = (inner) => String.raw`\((?:${COMMENT}|${QUOTED}|${inner}|\/(?!\*)|[^()"'/])*\)`;
const PRELUDE = String.raw`\s+|${COMMENT}|@(charset|layer|import)(?![\w-])(?:${COMMENT}|${QUOTED}|${group(group(group('(?!)')))}|\/(?!\*)|[^;{}()"'/])*(?:;|$)`;

// A stylesheet's leading @import rules, which count only before every other rule, with the @layer
// statements among them so its layers keep their order; and the rest of its text. A stylesheet with no
// @import comes back whole.
export function splitImports(css) {
  const prelude = new RegExp(PRELUDE, 'iy');
  const head = [];
  let rest = '';
  let end = 0;
  for (let m; (m = prelude.exec(css)); end = prelude.lastIndex) {
    // One at the very end may have no semicolon; moved ahead of other rules, it needs one.
    if (/^(?:import|layer)$/i.test(m[1] ?? '')) head.push(m[0].endsWith(';') ? m[0] : `${m[0]};`);
    else rest += m[0];
  }
  if (!head.some((rule) => /^@import/i.test(rule))) return { head: [], rest: css };
  return { head, rest: rest + css.slice(end) };
}
