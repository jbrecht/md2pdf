// Shrinks each displayed formula under `root` that is wider than its column until it fits, on screen and
// in print. KaTeX draws a displayed formula as one line that never wraps, so a long one runs off the page.
//
// Runs in the browser, once the page is rendered and its fonts have loaded. It measures each formula's
// width in proportion to its font size, which doesn't depend on the column, and sizes it with container
// query units. So the browser fits it to whatever column it ends up in, including the printed page's,
// which a script can't measure: when printing starts, the page is still laid out at screen width. A
// formula that fits keeps its size. Running it again is harmless.
//
// Self-contained, so the CLI can put its source in the page.
export function fitFormulas(root = document) {
  for (const formula of root.querySelectorAll('eqn > .katex-display > .katex')) {
    const display = formula.parentElement;
    const section = display.parentElement.parentElement;
    if (!section) continue;
    formula.style.fontSize = '';
    display.style.containerType = '';
    display.style.width = 'max-content';
    // A \tag number sits at the column's edge, outside the formula's own width. The formula is centred,
    // so clearing the number takes its width on both sides.
    const tag = formula.querySelector('.katex-html > .katex-tag');
    const width = formula.getBoundingClientRect().width + 2 * (tag?.getBoundingClientRect().width ?? 0);
    display.style.width = '';
    const size = parseFloat(getComputedStyle(formula).fontSize);
    const parentSize = parseFloat(getComputedStyle(display).fontSize);
    if (!(width > 0 && size > 0 && parentSize > 0)) continue;
    // The container is the formula's own block, whose margins collapse with the text around it as before:
    // a container's children's margins don't. A container sizes without its content, so one in a box that
    // sizes to its content, such as a table cell, would collapse it. Leave such a formula as it was.
    const before = section.getBoundingClientRect().width;
    display.style.containerType = 'inline-size';
    if (section.getBoundingClientRect().width !== before) {
      display.style.containerType = '';
      continue;
    }
    // Only the formula's own text scales, so the space above and below it stays the style's. Glyphs land on
    // rounded positions, so a formula's width doesn't scale exactly with its size: 99% of the column leaves room.
    formula.style.fontSize = `min(${size / parentSize}em, calc(99cqi * ${size / width}))`;
  }
}
