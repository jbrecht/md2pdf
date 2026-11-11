// Obsidian wikilinks and embeds. A link to another note can't go anywhere in a single PDF, so
// [[Note]], [[Note|alias]] and [[Note#Heading]] render as plain text, the way Obsidian displays them;
// only a same-note [[#Heading]] becomes a link. ![[image.png]] renders like ![](image.png), and other
// embeds, which neither the CLI nor the website can read, become a labelled placeholder.

const IMAGE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const FILE = /\.(3gp|canvas|flac|m4a|mkv|mov|mp3|mp4|ogg|ogv|pdf|wav|webm)$/i;
// Obsidian's ![[image.png|300]] and ![[image.png|300x200]] set the image's size.
const SIZE = /^(\d+)(?:x(\d+))?$/;

export default function wikilinks(md, { slugify }) {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    // Silent mode skips over a link's text; a rule that consumes its [ reads as a nested link and
    // breaks [see [[Note]]](url). A wikilink's brackets balance, so it can be skipped one character at a time.
    if (silent) return false;
    const { src, pos } = state;
    const embed = src.charCodeAt(pos) === 0x21 /* ! */;
    const start = pos + (embed ? 1 : 0);
    if (!src.startsWith('[[', start)) return false;
    // The inside runs to the first bracket or line break, which must start the closing ]]. Stopping at the
    // next [ keeps a run of unclosed [[ from each searching to the end of the paragraph.
    let end = start + 2;
    while (end < src.length && !'[]\n'.includes(src[end])) end++;
    if (!src.startsWith(']]', end)) return false;
    const inner = src.slice(start + 2, end);
    if (!inner.trim()) return false;
    // [[1]](url) is an ordinary link whose text is [1]; AI assistants write citations that way.
    if (src.charCodeAt(end + 2) === 0x28 /* ( */) return false;

    // In tables the pipe is escaped, [[Note\|alias]]; markdown-it unescapes it only inside table cells.
    const bar = inner.indexOf('|');
    const target = bar < 0 ? inner : inner.slice(0, inner[bar - 1] === '\\' ? bar - 1 : bar);
    const alias = bar < 0 ? '' : inner.slice(bar + 1);
    const [page, ...rest] = target.split('#').map((s) => s.trim());
    // Block references (#^id) name no heading to show.
    const headings = rest.filter((h) => h && !h.startsWith('^'));
    const name = [page, ...headings].filter(Boolean).join(' > ') || target.trim();
    const text = alias.trim() || name;
    if (!name) return false;

    if (embed && IMAGE.test(page)) image(state, page, alias.trim());
    // The placeholder names what was left out; Obsidian doesn't show an embed's alias either.
    else if (embed) {
      state.push('wikilink_embed', 'span', 0).meta = { kind: FILE.test(page) ? 'file' : 'note', text: name };
    } else if (!page && headings.length) {
      state.push('link_open', 'a', 1).attrs = [['href', `#${headingId(state.md, headings.at(-1))}`]];
      state.push('text', '', 0).content = text;
      state.push('link_close', 'a', -1);
    } else {
      state.push('text', '', 0).content = text;
    }
    state.pos = end + 2;
    return true;
  });

  // Heading ids are slugged from a heading's text after the typographer and emoji rules have run, so
  // `A -- B` has the id a--b. Slug the same text.
  const headingId = (md, heading) =>
    slugify(md.parseInline(heading, {})[0].children
      .filter((t) => t.type === 'text' || t.type === 'code_inline')
      .map((t) => t.content)
      .join(''));

  md.renderer.rules.wikilink_embed = (tokens, idx) => {
    const { kind, text } = tokens[idx].meta;
    return `<span class="markdown-embed">Embedded ${kind}: ${md.utils.escapeHtml(text)}</span>`;
  };
}

function image(state, path, alias) {
  const href = state.md.normalizeLink(path);
  const size = alias.match(SIZE);
  const alt = new state.Token('text', '', 0);
  alt.content = size ? path : alias || path;
  const token = state.push('image', 'img', 0);
  token.attrs = [['src', state.md.validateLink(href) ? href : ''], ['alt', '']];
  if (size) token.attrs.push(['width', size[1]], ...(size[2] ? [['height', size[2]]] : []));
  token.children = [alt];
  token.content = alt.content;
}
