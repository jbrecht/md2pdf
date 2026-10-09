# md2pdf Sample Document

This is a **sample** document with *emphasis*, ~~strikethrough~~, `inline code`, and a [link](https://github.com). Smart quotes: "hello" -- and emoji :rocket: :tada:

## Code

```js
// Syntax highlighted JavaScript
export function greet(name = 'world') {
  const message = `Hello, ${name}!`;
  console.log(message);
  return { message, length: message.length };
}
```

```python
def fib(n: int) -> int:
    """A very long line to check that code wraps rather than getting clipped at the right edge of the page."""
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

## Table

| Feature        | Supported | Notes                      |
| -------------- | :-------: | -------------------------- |
| Tables         | ✅        | Alignment works            |
| Task lists     | ✅        | Rendered as checkboxes     |
| Footnotes      | ✅        | See below[^1]              |

## Lists

- [x] Write the converter
- [x] Style it like GitHub
- [ ] Add more styles later

1. First
2. Second
   - Nested bullet
   - Another

> **Note**
> Blockquotes look like this. Relative images resolve against the Markdown file's folder:

![Blue bar](images/bar.png)

---

Raw <kbd>Cmd</kbd> + <kbd>Shift</kbd> HTML works too.

[^1]: This is the footnote text.
