// Shrinks each displayed formula under `root` that is wider than its column until it fits, on screen and
// in print. KaTeX draws a displayed formula as one line that never wraps, so a long one runs off the page.
//
// Runs in the browser, once the page is rendered and its fonts have loaded. It measures each formula's
// width in proportion to its font size, which doesn't depend on the column, and sizes it with container
// query units. So the browser fits it to whatever column it ends up in, including the printed page's,
// which a script can't measure: when printing starts, the page is still laid out at screen width. A
// formula that fits keeps its size. Running it again is harmless.
//
// Self-contained, so the CLI can put its source in the page. md2pdf.me fits formulas its own way, with
// the page's width, which its preview knows.
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

// Fits each table under `root` that runs past its box on the printed page, so every column prints. KaTeX's
// formulas never wrap, and a cell can't be narrower than its longest word, so a table of long words or a
// long formula can be wider than the page.
//
// Runs in the browser after fitFormulas, which resets every displayed formula's size, once the page is
// rendered and its fonts have loaded. A table's width depends on the column it ends up in, so it lays the
// page out at the printed column's width, read from the page's @page rules, while it measures. Then, for a
// table that runs past its box:
//   1. A formula in one of its cells shrinks, down to half size, keeping every word whole.
//   2. If that isn't enough, the body cells of its columns whose longest word is longer than 8 characters
//      break their words, widest column first, measuring after each, until it fits. A break that doesn't
//      narrow its column is taken back. If the table still doesn't fit, those columns' headers break too,
//      all at once, so the broken columns share the width; then every cell.
//   3. Its formulas then grow back as large as fits, or shrink further if they must.
// A table that fits isn't written to, so it prints as it did. If the printed width can't be read, nothing
// changes. Running it again is harmless.
//
// Self-contained, so the CLI can put its source in the page.
export function fitTables(root = document) {
  const FIT = 'data-md2pdf-fit';
  // Puts back an element's style attribute as it was. Chrome keeps an empty one after a script has
  // written its style, even through removeAttribute, unless the attribute is set first.
  const restore = (el, style) => {
    el.setAttribute('style', style ?? '');
    if (style === null) el.removeAttribute('style');
  };
  const unset = (el, ...properties) => {
    for (const property of properties) el.style.removeProperty(property);
    restore(el, el.getAttribute('style') || null);
    el.removeAttribute(FIT);
  };
  for (const el of root.querySelectorAll(`[${FIT}]`)) unset(el, 'overflow-wrap', 'font-size');
  const tables = [...root.querySelectorAll('table')];
  if (!tables.length) return;

  // The printed page's width and side margins: the last rule without a page selector that sets each.
  const page = {};
  const read = (rules) => {
    for (const rule of rules) {
      if (rule instanceof CSSPageRule) {
        if (rule.selectorText) continue;
        for (const name of ['size', 'margin-left', 'margin-right']) {
          const value = rule.style.getPropertyValue(name);
          if (value) page[name] = value;
        }
      } else if (rule instanceof CSSImportRule) {
        if (!rule.media.length || [...rule.media].some((m) => /\b(all|print)\b/i.test(m) && !/\bnot\b/i.test(m))) {
          try {
            read(rule.styleSheet.cssRules);
          } catch {
            // A stylesheet from another origin can't be read.
          }
        }
      } else if (rule instanceof CSSMediaRule) {
        if ([...rule.media].some((m) => /\b(all|print)\b/i.test(m) && !/\bnot\b/i.test(m))) read(rule.cssRules);
      } else if (rule.cssRules && !(rule instanceof CSSStyleRule)) {
        read(rule.cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      read(sheet.cssRules);
    } catch {
      // As above.
    }
  }
  const html = document.documentElement;
  const box = document.createElement('div');
  box.style.cssText = 'position: absolute; visibility: hidden; height: 0; padding: 0; border: 0';
  const probe = box.cloneNode();
  box.append(probe);
  html.append(box);
  const px = (length) => {
    if (!length || /v(w|h|min|max)$/i.test(length)) return NaN;
    probe.style.width = '';
    probe.style.width = length;
    return probe.style.width ? probe.getBoundingClientRect().width : NaN;
  };
  const PAPER = {
    a5: ['148mm', '210mm'], a4: ['210mm', '297mm'], a3: ['297mm', '420mm'], b5: ['176mm', '250mm'],
    b4: ['250mm', '353mm'], 'jis-b5': ['182mm', '257mm'], 'jis-b4': ['257mm', '364mm'],
    letter: ['8.5in', '11in'], legal: ['8.5in', '14in'], ledger: ['11in', '17in'],
  };
  // Chrome prints `auto`, or an orientation alone, on Letter paper.
  const words = (page.size || 'auto').trim().toLowerCase().split(/\s+/);
  const paper = PAPER[words.find((word) => PAPER[word]) ?? 'letter'];
  const width = /^[\d.+]/.test(words[0]) ? px(words[0]) : px(words.includes('landscape') ? paper[1] : paper[0]);
  // A margin in % is a share of the page's width.
  box.style.width = `${width}px`;
  const column = width - px(page['margin-left']) - px(page['margin-right']);
  box.remove();
  if (!(column > 0)) return;

  const style = html.getAttribute('style');
  html.style.width = `${column}px`;
  try {
    for (const table of tables) fit(table);
  } finally {
    restore(html, style);
  }

  function fit(table) {
    // How far the table reaches past its box.
    const past = () => {
      const parent = table.parentElement;
      const s = getComputedStyle(parent);
      const edge = parent.getBoundingClientRect().right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
      let right = table.getBoundingClientRect().right;
      for (const row of table.rows) right = Math.max(right, row.getBoundingClientRect().right);
      return right - edge;
    };
    // A table is fitted when it runs past its box by more than a pixel: less only reaches into the page
    // margin, and the slack keeps a rounding difference from the printed page's width from changing a table
    // that fits. Fitted, it stays inside its box.
    if (!table.parentElement || !(past() > 1)) return;
    const fits = () => past() <= 0;

    // The table's own cells, by column. A cell that spans columns is broken only with every cell (step 2).
    const columns = [];
    const taken = [];
    [...table.rows].forEach((row, r) => {
      let c = 0;
      for (const cell of row.cells) {
        while (taken[r]?.[c]) c++;
        for (let i = 0; i < (cell.rowSpan || 1); i++) {
          for (let j = 0; j < cell.colSpan; j++) (taken[r + i] ??= [])[c + j] = true;
        }
        if (cell.colSpan === 1) (columns[c] ??= []).push(cell);
        c += cell.colSpan;
      }
    });
    // Each column's width with every cell at its narrowest, as wide as its longest word or formula.
    const narrowest = () => {
      const before = table.getAttribute('style');
      table.style.width = 'min-content';
      const widths = columns.map((cells) => {
        if (!cells?.length) return 0;
        const s = getComputedStyle(cells[0]);
        const edges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, p) => sum + parseFloat(s[p]), 0);
        return cells[0].getBoundingClientRect().width - edges;
      });
      restore(table, before);
      return widths;
    };
    const eight = (cell) => {
      const span = document.createElement('span');
      span.style.cssText = 'position: absolute; visibility: hidden; width: 8ch; padding: 0; border: 0';
      cell.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    };
    const mark = (cell) => {
      cell.style.overflowWrap = 'anywhere';
      cell.setAttribute(FIT, '');
    };
    const long = (widths, c) => columns[c]?.length && widths[c] > eight(columns[c][0]);
    const body = (c) => columns[c].filter((cell) => cell.localName === 'td');
    // Breaks the body cells of the long columns, widest first, until the table fits. Returns whether it does.
    const breakBodies = () => {
      const tried = new Set();
      while (!fits()) {
        const widths = narrowest();
        let best = -1;
        widths.forEach((w, c) => {
          if (!tried.has(c) && long(widths, c) && body(c).length && (best < 0 || w > widths[best])) best = c;
        });
        if (best < 0) return false;
        tried.add(best);
        body(best).forEach(mark);
        if (narrowest()[best] >= widths[best] - 0.5) for (const cell of body(best)) unset(cell, 'overflow-wrap');
      }
      return true;
    };

    // Its formulas: displayed ones, and inline ones with a part longer than 8 characters that can't wrap.
    const formulas = [...table.querySelectorAll(':is(td, th) .katex')]
      .filter((formula) => formula.closest('table') === table)
      .filter((formula) => {
        if (formula.parentElement.classList.contains('katex-display')) return true;
        const parts = [...formula.querySelectorAll(':scope > .katex-html > .base')];
        return parts.some((part) => part.getBoundingClientRect().width > eight(formula.closest('td, th')));
      })
      .map((formula) => [formula, parseFloat(getComputedStyle(formula).fontSize) / parseFloat(getComputedStyle(formula.parentElement).fontSize)]);
    const scale = (factor) => {
      for (const [formula, size] of formulas) {
        formula.style.fontSize = `${size * factor}em`;
        formula.setAttribute(FIT, '');
      }
    };
    // The largest size from `small`, at which the table fits, up to `large`. At full size, they're left as
    // they were.
    const largest = (small, large) => {
      scale(large);
      if (fits()) {
        if (large === 1) for (const [formula] of formulas) unset(formula, 'font-size');
        return;
      }
      while (large - small > 0.01) {
        const middle = (small + large) / 2;
        scale(middle);
        if (!fits()) large = middle;
        else small = middle;
      }
      scale(small);
    };

    if (formulas.length) {
      scale(0.5);
      if (fits()) return largest(0.5, 1);
    }
    if (!breakBodies()) {
      const widths = narrowest();
      columns.forEach((cells, c) => long(widths, c) && cells.forEach(mark));
      if (!fits()) for (const row of table.rows) for (const cell of row.cells) mark(cell);
    }
    if (!formulas.length) return;
    if (fits()) return largest(0.5, 1);
    scale(0.05);
    if (!fits()) scale(0.5);
    else largest(0.05, 0.5);
  }
}
