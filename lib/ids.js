// Heading ids, as markdown-it-anchor 10 gives them with tabindex="-1": the heading's text slugged, and a
// repeated slug numbered -1, -2 and so on. markdown-it-anchor counts up from 1 for every repeat, which
// takes quadratic time on a document of identical headings; this remembers where each count got to.
//
// With an id prefix, heading and footnote ids start with it, and so does every link to a #fragment in the
// document, so links still find their targets and two documents on one page don't share ids.

export const ID_PREFIX = /^[A-Za-z][\w-]*-$/;

export default function ids(md, { slugify, idPrefix = '' }) {
  md.core.ruler.push('heading_ids', (state) => {
    const env = (state.env.md2pdfIds ??= { used: new Set(), next: new Map() });
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== 'heading_open') continue;
      const text = state.tokens[i + 1].children
        .filter((t) => t.type === 'text' || t.type === 'code_inline')
        .map((t) => t.content)
        .join('');
      const slug = slugify(text);
      let id = slug;
      if (env.used.has(id)) {
        let n = env.next.get(slug) ?? 1;
        while (env.used.has(`${slug}-${n}`)) n++;
        id = `${slug}-${n}`;
        env.next.set(slug, n + 1);
      }
      env.used.add(id);
      token.attrSet('id', idPrefix + id);
      token.attrSet('tabindex', '-1');
    }
  });

  if (!idPrefix) return;
  // Pushed after footnote_tail has moved footnotes to the end, so links inside them are rewritten too.
  md.core.ruler.push('id_prefix_links', (state) => {
    for (const token of state.tokens) {
      for (const child of token.children ?? []) {
        if (child.type !== 'link_open') continue;
        const href = child.attrGet('href');
        if (href?.startsWith('#') && href.length > 1) child.attrSet('href', `#${idPrefix}${href.slice(1)}`);
      }
    }
  });
}
