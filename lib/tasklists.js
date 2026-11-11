// GitHub task lists: a list item starting `[ ] ` or `[x] ` gets a checkbox that can't be ticked, inside a
// label with the item's text. The markup is that of markdown-it-task-lists 2.1.1 with { label: true }.
// That plugin keeps its options in module variables, so another markdown-it on the page that uses it with
// other options changes md2pdf's task lists too, and its labelAfter option writes the item's text out as
// raw HTML.

const TASK = /^\[[ xX]\] /;

export default function taskLists(md) {
  md.core.ruler.after('inline', 'task_lists', (state) => {
    const tokens = state.tokens;
    // The open token at each nesting level, to find a list item's list without searching back.
    const open = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.nesting === 1) open[token.level] = token;
      if (
        i < 2 ||
        token.type !== 'inline' ||
        tokens[i - 1].type !== 'paragraph_open' ||
        tokens[i - 2].type !== 'list_item_open' ||
        !TASK.test(token.content)
      ) continue;

      const checkbox = new state.Token('task_checkbox', '', 0);
      checkbox.meta = { checked: token.content[1] !== ' ' };
      token.children.unshift(checkbox);
      // As in markdown-it-task-lists, which takes the marker off the first child whatever it is: an item
      // whose [x] is a link reference keeps the link.
      token.children[1].content = token.children[1].content.slice(3);
      token.content = token.content.slice(3);
      token.children.unshift(new state.Token('task_label_open', 'label', 1));
      token.children.push(new state.Token('task_label_close', 'label', -1));

      tokens[i - 2].attrSet('class', 'task-list-item');
      open[tokens[i - 2].level - 1]?.attrSet('class', 'contains-task-list');
    }
  });

  md.renderer.rules.task_checkbox = (tokens, idx) =>
    `<input class="task-list-item-checkbox"${tokens[idx].meta.checked ? ' checked=""' : ''} disabled="" type="checkbox">`;
  md.renderer.rules.task_label_open = () => '<label>';
  md.renderer.rules.task_label_close = () => '</label>';
}
