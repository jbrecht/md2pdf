// TeX math, rendered by KaTeX: $…$ and \(…\) inline, $$…$$, \[…\] and \begin{env}…\end{env} displayed,
// and a number in parentheses after a displayed formula, `$$E = mc^2$$ (1)`. The syntax is that of
// markdown-it-texmath 1.0.0 with its brackets, dollars and beg_end delimiters and outerSpace, except that
// a $ formula may also start or end beside a line break. texmath searches for the closing delimiter from
// every opening one, which takes quadratic time on a line of openers, so these rules find closers through
// tables built in one pass over the source. A displayed formula also ends inside the blockquote it starts
// in; texmath's could run on past it, so that each of a run of quotes echoed the rest of the document.

import { first, nextWhere } from './scan.js';

const MAX_LENGTH = 8000;
// How deep braces may nest. KaTeX recurses once per level and overflows its stack at a few hundred, which
// takes it milliseconds per formula; a document of formulas that all do so takes seconds.
const MAX_DEPTH = 100;
// Macro definitions are refused: a few hundred bytes of nested definitions expand to minutes of work. So is
// a line break before the word (\\def), since counting backslashes can't tell where KaTeX's tokens end:
// \verb\a\ ends at its second backslash.
const DEFINITION = /\\(?:[egx]?def|let|futurelet|global|long|(?:re|provide)?newcommand)(?![a-zA-Z])/;
// Caps how far a formula can reach (\rule, \raisebox, \hspace). Negative sizes aren't capped.
const MAX_SIZE = 30;
// The HTML a document's formulas may add up to, in characters, by default. KaTeX's HTML is about 50 to 250 times
// its TeX for ordinary formulas and over 500 times for a matrix of empty cells; a formula that would take
// the HTML past the budget, and every one after it, shows as its source.
const MAX_HTML = 10_000_000;

// How deeply {…} nest in `tex`, not counting a brace after a backslash.
function braceDepth(tex) {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === '\\') i++;
    else if (c === '{') max = Math.max(max, ++depth);
    else if (c === '}' && depth > 0) depth--;
  }
  return max;
}

const SPACE = /\s/;
const isBreak = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);

const closeParen = (s, i) => s.startsWith('\\)', i);
const openBracket = (s, i) => s.startsWith('\\[', i);
const closeBracket = (s, i) => s.startsWith('\\]', i);
const dollar = (s, i) => s[i] === '$';
// A $ that can close an inline formula: not after a space or a backslash.
const dollarCloser = (s, i) => s[i] === '$' && i > 0 && !SPACE.test(s[i - 1]) && s[i - 1] !== '\\';
const lineBreak = (s, i) => isBreak(s[i]);
const nonSpace = (s, i) => !SPACE.test(s[i]);
const bracketNumberStop = (s, i) => ')$\r\n'.includes(s[i]);
const dollarNumberStop = (s, i) => s[i] === ')' || SPACE.test(s[i]);

// Whether the $ at `at` opens or closes a formula: whitespace or the paragraph's edge is outside it,
// or after a closing $, punctuation that ends a clause.
const dollarPre = (src, at) => at === 0 || SPACE.test(src[at - 1]);
const dollarPost = (src, at) => at + 1 >= src.length || /[\s.,;]/.test(src[at + 1]);
// texmath's own test for $$ inside a paragraph, which outerSpace doesn't reach: no backslash or digit
// before the opening $$, and no digit after the closing one.
const isDigit = (c) => c >= '0' && c <= '9';
const doublePre = (src, at) => at === 0 || (src[at - 1] !== '\\' && !isDigit(src[at - 1]));
const doublePost = (src, at) => !isDigit(src[at + 1] ?? '');

// The ways $$…$$ can close after the $$ at `at`, in texmath's order: \$\$([^$]*?[^\\])\$\$.
function* doubleDollar(state, at) {
  const { src } = state;
  const d = first(state, dollar, at + 2);
  if (d < 0) return;
  if (d - 1 >= at + 2 && src[d - 1] !== '\\' && src[d + 1] === '$') yield { content: src.slice(at + 2, d), end: d + 2 };
  if (src[d + 1] === '$' && src[d + 2] === '$') yield { content: src.slice(at + 2, d + 1), end: d + 3 };
}

// $…$ from `at`, as texmath's \$((?:[^\s\\])|(?:\S.*?[^\s\\]))\$ matches it, or null.
function singleDollar(state, at) {
  const { src } = state;
  const c = src[at + 1];
  if (c === undefined || SPACE.test(c)) return null;
  if (c !== '\\' && src[at + 2] === '$') return { content: c, end: at + 3 };
  const close = first(state, dollarCloser, at + 2);
  if (close < 0) return null;
  const br = first(state, lineBreak, at + 2);
  if (br >= 0 && br < close) return null;
  return { content: src.slice(at + 1, close), end: close + 1 };
}

// \(…\) from `at`, as \\\((.+?)\\\) matches it, or null.
function parens(state, at) {
  const close = first(state, closeParen, at + 3);
  if (close < 0) return null;
  const br = first(state, lineBreak, at + 2);
  if (br >= 0 && br < close) return null;
  return { content: state.src.slice(at + 2, close), end: close + 2 };
}

function inline(state, silent) {
  const { src, pos } = state;
  let type;
  let match;
  if (src.startsWith('\\(', pos)) {
    type = 'math_inline';
    match = parens(state, pos);
  } else if (src[pos] === '$') {
    // texmath's order: $$ then $ with md2pdf's outer tests, then $$ with texmath's own.
    const double = src[pos + 1] === '$' ? doubleDollar(state, pos).next().value : null;
    const outer = dollarPre(src, pos);
    if (outer && double && dollarPost(src, double.end - 1)) {
      [type, match] = ['math_inline_double', double];
    } else if (outer && (match = singleDollar(state, pos)) && dollarPost(src, match.end - 1)) {
      type = 'math_inline';
    } else if (double && doublePre(src, pos) && doublePost(src, double.end - 1)) {
      [type, match] = ['math_inline_double', double];
    } else {
      match = null;
    }
  }
  if (!match) return false;
  if (!silent) {
    const token = state.push(type, 'math', 0);
    token.content = match.content;
    token.markup = type === 'math_inline_double' ? '$$' : src.slice(pos, pos + (src[pos] === '$' ? 1 : 2));
  }
  state.pos = match.end;
  return true;
}

// An equation number after a displayed formula that ends at `from`: whitespace, then (number).
function equationNumber(state, from, stop) {
  const open = first(state, nonSpace, from);
  if (open < 0 || state.src[open] !== '(') return null;
  const close = first(state, stop, open + 1);
  if (close <= open + 1 || state.src[close] !== ')') return null;
  return { info: state.src.slice(open + 1, close), end: close + 1 };
}

// The first `\end{name}` at or after `from`, or -1.
function environmentEnd(state, name, from) {
  if (!state.md2pdfEnds) {
    state.md2pdfEnds = new Map();
    for (const m of state.src.matchAll(/\\end\{([a-z]+)\}/g)) {
      if (!state.md2pdfEnds.has(m[1])) state.md2pdfEnds.set(m[1], []);
      state.md2pdfEnds.get(m[1]).push(m.index);
    }
  }
  const ends = state.md2pdfEnds.get(name) ?? [];
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < ends.length ? ends[lo] : -1;
}

const BEGIN = /\\begin\{([a-z]+)\}/y;

// The displayed formula starting at `at`, trying texmath's block rules in their order, or null.
function displayed(state, at) {
  const { src } = state;
  if (src.startsWith('\\[', at)) {
    const close = first(state, closeBracket, at + 2);
    const open = first(state, openBracket, at + 2);
    if (close > at + 2 && (open < 0 || open > close)) {
      const number = equationNumber(state, close + 2, bracketNumberStop);
      if (number) return { type: 'math_block_eqno', tag: '\\[', content: src.slice(at + 2, close), ...number };
    }
    const end = first(state, closeBracket, at + 3);
    if (end >= 0) return { type: 'math_block', tag: '\\[', content: src.slice(at + 2, end), end: end + 2 };
  }
  if (src.startsWith('$$', at)) {
    for (const { content, end } of doubleDollar(state, at)) {
      const number = equationNumber(state, end, dollarNumberStop);
      if (number) return { type: 'math_block_eqno', tag: '$$', content, ...number };
    }
    const match = doubleDollar(state, at).next().value;
    if (match) return { type: 'math_block', tag: '$$', ...match };
  }
  if (src[at] === '\\') {
    BEGIN.lastIndex = at;
    const begin = BEGIN.exec(src);
    const close = begin && environmentEnd(state, begin[1], at + begin[0].length + 1);
    if (begin && close >= 0) {
      const end = close + `\\end{${begin[1]}}`.length;
      return { type: 'math_block', tag: '\\', content: src.slice(at, end), info: begin[1], end };
    }
  }
  return null;
}

// texmath's content.replace(/(\n*?^(?:\s*>)+)/gm, ''), which takes the > markers off the lines of a
// formula in a blockquote, in one pass.
function unquote(s) {
  const next = nextWhere(s, nonSpace);
  let out = '';
  let kept = 0;
  for (let p = 0; p < s.length; ) {
    let w = p === 0 || isBreak(s[p - 1]) || s[p] === '\n' ? next[p] : -1;
    if (w < 0 || s[w] !== '>') {
      p++;
      continue;
    }
    while (next[w + 1] >= 0 && s[next[w + 1]] === '>') w = next[w + 1];
    out += s.slice(kept, p);
    kept = p = w + 1;
  }
  return out + s.slice(kept);
}

function block(state, startLine, endLine, silent) {
  const match = displayed(state, state.bMarks[startLine] + state.tShift[startLine]);
  const last = match ? match.end - 1 : -1;
  // Inside a blockquote, endLine is the quote's end, for the lists and other blocks inside it too.
  if (!match || last > state.eMarks[endLine - 1]) return false;
  let line = startLine;
  while (line < endLine && !(last >= state.bMarks[line] + state.tShift[line] && last <= state.eMarks[line])) line++;
  // Text after the closing delimiter on its line was dropped with the rest of the line, by texmath too. On
  // the formula's first line, declining leaves it to the inline rules, which keep the text beside the
  // formula. A formula over several lines stays a block, and the text follows it as a paragraph, since the
  // paragraph and list rules would otherwise get its lines.
  const rest = line < endLine ? state.src.slice(match.end, state.eMarks[line]).trim() : '';
  if (rest && line === startLine) return false;
  if (silent) return true;
  const token = state.push(match.type, 'math', 0);
  token.block = true;
  token.tag = match.tag;
  token.markup = '';
  token.content = state.parentType === 'blockquote' ? unquote(match.content) : match.content;
  // texmath's info is the equation number, the environment's name, or else the formula.
  token.info = match.info ?? token.content;
  token.map = [startLine, line + 1];
  state.line = line + 1;
  if (rest) {
    const open = state.push('paragraph_open', 'p', 1);
    const inline = state.push('inline', '', 0);
    inline.content = rest;
    inline.children = [];
    const close = state.push('paragraph_close', 'p', -1);
    open.map = inline.map = [line, line + 1];
    open.block = close.block = true;
  }
  return true;
}

export default function math(md, { katex, maxHtml = MAX_HTML }) {
  if (!(typeof maxHtml === 'number' && maxHtml >= 0)) {
    throw new TypeError(`math.maxHtml must be a number of characters, 0 or more: ${String(maxHtml)}`);
  }
  const error = (tex, reason) =>
    `<span class="katex-error" title="${escapeHtml(reason)}" style="color:#cc0000">${escapeHtml(tex)}</span>`;
  const render = (tex, displayMode) => {
    if (tex.length > MAX_LENGTH) return error(tex, `Formulas over ${MAX_LENGTH} characters aren't rendered`);
    if (braceDepth(tex) > MAX_DEPTH) return error(tex, `Formulas nested over ${MAX_DEPTH} levels deep aren't rendered`);
    if (DEFINITION.test(tex)) return error(tex, 'Macro definitions aren\'t supported');
    try {
      return katex.renderToString(tex, {
        displayMode,
        output: 'html',
        throwOnError: false,
        trust: false,
        maxSize: MAX_SIZE,
        maxExpand: 1000,
        // KaTeX warns on the console about TeX that LaTeX wouldn't take, once per occurrence.
        strict: 'ignore',
      });
    } catch (err) {
      // KaTeX reports bad TeX as an error box itself; this is for its own limits, like nesting too deep.
      return escapeHtml(`${tex}:${err.message}`);
    }
  };

  // The budget is spent in document order and starts again with each render. Only the first formula past it
  // says why: the reason on each of a run of short formulas would make the HTML 40 times the Markdown.
  let budget;
  const budgeted = (tex, displayMode) => {
    if (budget.used <= maxHtml) {
      const html = render(tex, displayMode);
      budget.used += html.length;
      if (budget.used <= maxHtml) return html;
      return error(tex, `The document's formulas reached their limit of ${maxHtml.toLocaleString('en-US')} characters of HTML`);
    }
    return `<span class="katex-error" style="color:#cc0000">${escapeHtml(tex)}</span>`;
  };

  // Before escape, so \( isn't taken as an escaped (.
  md.inline.ruler.before('escape', 'math_inline', inline);
  md.block.ruler.before('fence', 'math_block', block);
  // A render a rule starts inside another, such as a plugin's md.renderInline, spends the outer one's budget.
  let depth = 0;
  const withBudget = (renderTokens) =>
    function (...args) {
      if (depth++ === 0) budget = { used: 0 };
      try {
        return renderTokens.apply(this, args);
      } finally {
        depth--;
      }
    };
  md.renderer.render = withBudget(md.renderer.render);
  md.renderer.renderInline = withBudget(md.renderer.renderInline);
  md.renderer.rules.math_inline = (tokens, idx) => `<eq>${budgeted(tokens[idx].content, false)}</eq>`;
  md.renderer.rules.math_inline_double = md.renderer.rules.math_block = (tokens, idx) =>
    `<section><eqn>${budgeted(tokens[idx].content, true)}</eqn></section>`;
  md.renderer.rules.math_block_eqno = (tokens, idx) =>
    `<section class="eqno"><eqn>${budgeted(tokens[idx].content, true)}</eqn><span>(${escapeHtml(tokens[idx].info)})</span></section>`;
}
