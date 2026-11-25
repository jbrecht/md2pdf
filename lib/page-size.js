// The @page sizes md2pdf takes, shared by the CLI and buildDocument: auto, a paper name, an orientation or
// both, or one or two lengths. Chrome prints a size it can't read at Letter without a word. It also reads
// calc() and newer units, which aren't taken here.

export const PAPER = ['a5', 'a4', 'a3', 'b5', 'b4', 'jis-b5', 'jis-b4', 'letter', 'legal', 'ledger'];
const ORIENTATION = ['portrait', 'landscape'];
const LENGTH = /^\+?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?:in|cm|mm|q|pt|pc|px|em|rem|ex|ch|vw|vh|vmin|vmax)$/;
// buildDocument writes a size that passes straight into its <style> element, so this is checked first, on the
// string as given: whatever the word rules below come to accept, nothing else can reach the stylesheet. Only
// CSS's whitespace separates words; to CSS, a no-break space is part of a word.
const CHARACTERS = /^[A-Za-z0-9.+\- \t\n\r\f]*$/;

export function isPageSize(size) {
  if (typeof size !== 'string' || !CHARACTERS.test(size)) return false;
  const words = size.trim().toLowerCase().split(/\s+/);
  if (words.length > 2) return false;
  if (words.every((w) => LENGTH.test(w)) || size.trim().toLowerCase() === 'auto') return true;
  const count = (list) => words.filter((w) => list.includes(w)).length;
  return count(PAPER) <= 1 && count(ORIENTATION) <= 1 && count(PAPER) + count(ORIENTATION) === words.length;
}
