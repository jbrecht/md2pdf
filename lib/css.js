// Stylesheet text handling for the CLI and the tests.

import { cssString } from './render.js';

// A comment, a string, or a url() whose groups hold its double-quoted, single-quoted or bare reference.
const STRING = (q) => `${q}(?:\\\\[^]|[^${q}\\\\\\n])*${q}`;
const TOKENS = new RegExp(
  String.raw`\/\*[^]*?\*\/|${STRING('"')}|${STRING("'")}|url\(\s*(?:"((?:\\[^]|[^"\\\n])*)"|'((?:\\[^]|[^'\\\n])*)'|([^)\s'"\\]*))\s*\)`,
  'gi',
);

// Replaces each relative url() in a stylesheet with url(<resolve(ref)>), leaving comments, strings,
// and references that are absolute, root-relative, fragments or contain CSS escapes as they are.
export function rewriteUrls(css, resolve) {
  return css.replace(TOKENS, (whole, dq, sq, bare) => {
    const ref = dq ?? sq ?? bare;
    if (!ref || ref.includes('\\') || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(ref)) return whole;
    return `url(${cssString(resolve(ref))})`;
  });
}

// The relative references a stylesheet's url()s make, as rewriteUrls sees them.
export function relativeUrls(css) {
  const refs = [];
  rewriteUrls(css, (ref) => (refs.push(ref), ref));
  return refs;
}
