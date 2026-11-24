// markdown-it's typographic replacements without (c), (r) and (tm), which it turns into ©, ® and ™ wherever
// they stand: the last of "(a) (b) (c)", "Rule 12(c)", "f(r)". Its one option, typographer, covers them
// together with the dashes, the ellipsis and ±, so this is its `replacements` rule (15.0.2) with the rest.

const RARE = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/;

export default function typography(md) {
  md.core.ruler.at('replacements', (state) => {
    if (!state.md.options.typographer) return;
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !RARE.test(block.content)) continue;
      let insideAutolink = 0;
      for (let i = block.children.length - 1; i >= 0; i--) {
        const token = block.children[i];
        if (token.type === 'text' && !insideAutolink && RARE.test(token.content)) {
          token.content = token.content
            .replace(/\+-/g, '±')
            // .., ..., ....... -> …, but ?..... and !..... -> ?.. and !..
            .replace(/\.{2,}/g, '…')
            .replace(/([?!])…/g, '$1..')
            .replace(/([?!]){4,}/g, '$1$1$1')
            .replace(/,{2,}/g, ',')
            .replace(/(^|[^-])---(?=[^-]|$)/gm, '$1—')
            .replace(/(^|\s)--(?=\s|$)/gm, '$1–')
            .replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, '$1–');
        }
        if (token.type === 'link_open' && token.info === 'auto') insideAutolink--;
        if (token.type === 'link_close' && token.info === 'auto') insideAutolink++;
      }
    }
  });
}
