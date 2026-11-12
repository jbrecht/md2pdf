// Changes to markdown-it-footnote 4. Two of its rules take quadratic time, and these are the same rules
// made linear: footnote_tail, which moves footnotes to the end of the document, copied the whole token
// list once per footnote, and footnote_ref searched for the end of a [^label] from every [^ in a run of
// them. With an id prefix, footnote ids start with it, and a colon after `fn` keeps them apart from
// heading ids, which have none: `# fn1` would otherwise share the first footnote's id.

import { first } from './scan.js';

// Each inline note ^[…] becomes a reference, a list item and a back-link, about 70 times the three
// characters of an empty one, so a document gets this many; the rest stay text.
const MAX_INLINE = 1000;

export default function footnotes(md, { idPrefix = '' }) {
  const inline = md.inline.ruler.__rules__.find((r) => r.name === 'footnote_inline')?.fn;
  if (!inline) throw new Error('markdown-it-footnote has no footnote_inline rule to limit');
  md.inline.ruler.at('footnote_inline', (state, silent) => {
    if (state.env.md2pdfInlineNotes >= MAX_INLINE) return false;
    if (!inline(state, silent)) return false;
    if (!silent) state.env.md2pdfInlineNotes = (state.env.md2pdfInlineNotes ?? 0) + 1;
    return true;
  });
  md.core.ruler.at('footnote_tail', footnoteTail);
  md.inline.ruler.at('footnote_ref', footnoteRef);
  if (!idPrefix) return;

  const { rules } = md.renderer;
  const name = (tokens, idx, options, env, slf) => {
    const id = slf.rules.footnote_anchor_name(tokens, idx, options, env, slf);
    return tokens[idx].meta.subId > 0 ? [id, `${id}:${tokens[idx].meta.subId}`] : [id, id];
  };
  rules.footnote_ref = (tokens, idx, options, env, slf) => {
    const [id, refId] = name(tokens, idx, options, env, slf);
    const caption = slf.rules.footnote_caption(tokens, idx, options, env, slf);
    return `<sup class="footnote-ref"><a href="#${idPrefix}fn:${id}" id="${idPrefix}fnref:${refId}">${caption}</a></sup>`;
  };
  rules.footnote_open = (tokens, idx, options, env, slf) =>
    `<li id="${idPrefix}fn:${name(tokens, idx, options, env, slf)[1]}" class="footnote-item">`;
  rules.footnote_anchor = (tokens, idx, options, env, slf) =>
    ` <a href="#${idPrefix}fnref:${name(tokens, idx, options, env, slf)[1]}" class="footnote-backref">↩︎</a>`;
}

function footnoteTail(state) {
  if (!state.env.footnotes) return;
  const refTokens = {};
  let current;
  let label;
  let insideRef = false;
  state.tokens = state.tokens.filter((tok) => {
    if (tok.type === 'footnote_reference_open') {
      insideRef = true;
      current = [];
      label = tok.meta.label;
      return false;
    }
    if (tok.type === 'footnote_reference_close') {
      insideRef = false;
      // ':' keeps labels apart from Object.prototype's members.
      refTokens[`:${label}`] = current;
      return false;
    }
    if (insideRef) current.push(tok);
    return !insideRef;
  });

  const list = state.env.footnotes.list;
  if (!list) return;
  const out = state.tokens;
  out.push(new state.Token('footnote_block_open', '', 1));
  let tokens;
  for (let i = 0; i < list.length; i++) {
    const open = new state.Token('footnote_open', '', 1);
    open.meta = { id: i, label: list[i].label };
    out.push(open);

    if (list[i].tokens) {
      const paragraphOpen = new state.Token('paragraph_open', 'p', 1);
      paragraphOpen.block = true;
      const inline = new state.Token('inline', '', 0);
      inline.children = list[i].tokens;
      inline.content = list[i].content;
      const paragraphClose = new state.Token('paragraph_close', 'p', -1);
      paragraphClose.block = true;
      tokens = [paragraphOpen, inline, paragraphClose];
    } else if (list[i].label) {
      tokens = refTokens[`:${list[i].label}`];
    }
    // As in the original, a footnote that has neither repeats the previous one's tokens.
    if (tokens) for (const t of tokens) out.push(t);

    const lastParagraph = out[out.length - 1].type === 'paragraph_close' ? out.pop() : null;
    const count = list[i].count > 0 ? list[i].count : 1;
    for (let j = 0; j < count; j++) {
      const anchor = new state.Token('footnote_anchor', '', 0);
      anchor.meta = { id: i, subId: j, label: list[i].label };
      out.push(anchor);
    }
    if (lastParagraph) out.push(lastParagraph);
    out.push(new state.Token('footnote_close', '', -1));
  }
  out.push(new state.Token('footnote_block_close', '', -1));
}

// A label ends at the first ], and can't hold a space or a line break.
const labelStop = (s, i) => s[i] === ']' || s[i] === ' ' || s[i] === '\n';

function footnoteRef(state, silent) {
  const { src, posMax: max, pos: start } = state;
  if (start + 3 > max) return false;
  const footnotes = state.env.footnotes;
  if (!footnotes?.refs || src.charCodeAt(start) !== 0x5b /* [ */ || src.charCodeAt(start + 1) !== 0x5e /* ^ */) return false;
  const end = first(state, labelStop, start + 2);
  if (end < 0 || end >= max || src[end] !== ']' || end === start + 2) return false;

  const label = src.slice(start + 2, end);
  if (typeof footnotes.refs[`:${label}`] === 'undefined') return false;
  if (!silent) {
    footnotes.list ??= [];
    let id = footnotes.refs[`:${label}`];
    if (id < 0) {
      id = footnotes.list.length;
      footnotes.list[id] = { label, count: 0 };
      footnotes.refs[`:${label}`] = id;
    }
    const subId = footnotes.list[id].count++;
    const token = state.push('footnote_ref', '', 0);
    token.meta = { id, subId, label };
  }
  state.pos = end + 1;
  state.posMax = max;
  return true;
}
