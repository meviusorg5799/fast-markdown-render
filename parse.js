// Fast Markdown renderer — a dependency-free reimplementation of the
// CommonMark 0.31.2 + GFM 0.29 parsing algorithm as marked 18.1.3 performs
// it, written from scratch. parse(markdown) returns exactly the HTML that
// marked.parse returns with marked's defaults (gfm on, breaks off,
// pedantic off, async off). No part of marked's source is vendored here;
// the implementation below follows the algorithm's structure (block lexer,
// inline lexer with delimiter scanning, renderer) with my own code.
//
// Architecture:
//   * block rules + inline rules: composite regexes built by literal
//     fragment substitution (see edit()).
//   * Tokenizer: block tokenizers (space, code, fences, heading, hr,
//     blockquote, list, html, def, table, lheading, paragraph, text) and
//     inline tokenizers (escape, tag, link, reflink, emStrong, codespan,
//     br, del, autolink, url, inlineText).
//   * Lexer: drives the tokenizers, queues inline parsing of block text.
//   * Parser + Renderer (+ TextRenderer for image alt text): tokens to HTML.

// ---------------------------------------------------------------- helpers

const CARET_STRIP = /(^|[^\[])\^/g;

// Build a composite regex by substituting literal fragments into a pattern.
// `pattern` is a RegExp or a string; `flags` are the flags of the result.
// replace(name, fragment) swaps the first occurrence of `name` (a string,
// or every match when it is a global RegExp) for the fragment's source,
// after stripping a leading `^` from the fragment (a fragment anchored at
// its own start must not anchor the composite in the middle).
function edit(pattern, flags) {
  let text = typeof pattern === 'string' ? pattern : pattern.source;
  const api = {
    replace(search, value) {
      let frag = typeof value === 'string' ? value : value.source;
      frag = frag.replace(CARET_STRIP, '$1');
      text = text.replace(search, frag);
      return api;
    },
    getRegex() {
      return new RegExp(text, flags);
    },
  };
  return api;
}

// Does this runtime support lookbehind in regular expressions?
const HAS_LOOKBEHIND = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML special characters. With `encode`, `&` is always escaped;
// without it, an `&` that already starts a valid character/entity reference
// is left alone.
function escapeHtml(str, encode) {
  if (encode) {
    return ESCAPE_TEST.test(str) ? str.replace(ESCAPE_REPLACE, (ch) => ESCAPE_MAP[ch]) : str;
  }
  return ESCAPE_TEST_NO_ENCODE.test(str)
    ? str.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_MAP[ch])
    : str;
}

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references (and stray `&` to `&amp;`). Code
// points 0, above 0x10FFFF, or in the surrogate range become U+FFFD;
// 38 (`&`) becomes `&amp;` so it is not re-decoded later.
function unescapeHtml(str) {
  if (!NUMERIC_REF.test(str)) return str;
  return str.replace(NUMERIC_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// encodeURI, except that a literal `%` in the input stays `%` (encodeURI
// turns it into %25, which marked then turns back). Returns null when the
// URL cannot be encoded.
function cleanUrl(url) {
  try {
    return encodeURI(url).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Index of the closing bracket matching the opener at the start of `str`,
// where `pair` is e.g. '()' or '[]'. -1 when there is no closer, -2 when
// the string ends with unmatched openers. A backslash skips the next char.
function findClosingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === pair[0]) {
      depth++;
    } else if (str[i] === pair[1] && (depth--, depth < 0)) {
      return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row on unescaped pipes. When `count` is given, the result
// is trimmed/padded to exactly that many cells.
function splitCells(row, count) {
  const spaced = row.replace(/\|/g, (ch, off, whole) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && whole[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(' |');
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Strip trailing characters: with `invert` false, strip `ch` itself;
// with `invert` true, strip anything that is not `ch`.
function rtrim(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}

// Drop trailing blank lines, keeping at most one trailing blank line's
// worth of newlines (used for raw HTML blocks).
function stripTrailingBlanks(str) {
  const lines = str.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && /^[ \t]*$/.test(lines[last]); last--) {}
  return lines.length - last <= 2 ? str : lines.slice(0, last + 1).join('\n');
}

// Normalize a link reference label for lookup: trim, collapse whitespace,
// and case-fold (with a round trip through upper case, as marked does).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// The first non-space character of a line ('' when the line is blank or
// indented more than three spaces). Block-start regexes only allow up to
// three leading spaces, so a line whose first non-space character cannot
// start a given block can skip that block's test entirely.
function lineStartChar(line) {
  let spaces = 0;
  while (spaces < line.length && line[spaces] === ' ') spaces++;
  if (spaces > 3) return '';
  return line[spaces] ?? '';
}

// Expand tabs in `str` to spaces, tracking the column starting at `col`.
function expandTabs(str, col = 0) {
  let out = '';
  let at = col;
  for (const ch of str) {
    if (ch === '\t') {
      const width = 4 - (at % 4);
      out += ' '.repeat(width);
      at += width;
    } else {
      out += ch;
      at++;
    }
  }
  return out;
}

// ------------------------------------------------------------ small regexes

const RX = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // Factories for regexes that depend on the current indent level. The
  // indent a nested block may have is clamped to min(3, indent - 1):
  // a sub-list, fence, heading or quote indented further than that is
  // content of the current item, not a new block at this level.
  listItemRegex: (bullet) => new RegExp(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: memoIndent((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: memoIndent((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}>`)),
};

// Clamp a nested-block indent to the range the indent factories use.
function clampIndent(indent) {
  return Math.max(0, Math.min(3, indent - 1));
}

// Memoize a factory of indent-dependent regexes by clamped indent, so a
// long document's many list items share the same few compiled patterns.
function memoIndent(factory) {
  const cache = [];
  return (indent) => {
    const n = clampIndent(indent);
    return cache[n] || (cache[n] = factory(n));
  };
}

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ------------------------------------------------------------- block rules

const BLOCK = (() => {
  const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
  const codeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
  const fencesRe =
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
  const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
  const bulletRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
  // The setext-heading skeleton; `table` is the GFM table interruption.
  const lheadingSrc =
    /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
  const lheadingRe = edit(lheadingSrc)
    .replace(/bull/g, bulletRe)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    // Non-capturing here: a capturing hr would shift the (=+|-+) group
    // from group 2 and break the depth lookup.
    .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
    .getRegex();
  // The paragraph skeleton: a run of lines that does not start a new block.
  const paragraphSrc = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
  const paragraphFor = (listPattern) =>
    edit(paragraphSrc)
      .replace('hr', hrRe)
      .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
      .replace('|lheading', '')
      .replace('|table', '')
      .replace('blockquote', ' {0,3}>')
      .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
      .replace('list', listPattern)
      .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
      .replace('tag', BLOCK_TAGS)
      .getRegex();
  const blockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace(
    'paragraph',
    paragraphFor(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/),
  ).getRegex();
  const listRe = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, bulletRe).getRegex();
  const htmlRe = edit(
    '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
    'i',
  )
    .replace('comment', HTML_COMMENT)
    .replace('tag', BLOCK_TAGS)
    .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
    .getRegex();
  const labelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
  const defRe = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
    .replace('label', labelRe)
    .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
    .getRegex();
  const tableRe = edit(
    '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
  )
    .replace('hr', hrRe)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('blockquote', ' {0,3}>')
    .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS)
    .getRegex();
  const paragraphRe = edit(paragraphSrc)
    .replace('hr', hrRe)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('table', tableRe)
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS)
    .getRegex();
  return {
    newline: newlineRe,
    code: codeRe,
    fences: fencesRe,
    hr: hrRe,
    heading: headingRe,
    blockquote: blockquoteRe,
    list: listRe,
    html: htmlRe,
    def: defRe,
    table: tableRe,
    lheading: lheadingRe,
    paragraph: paragraphRe,
    text: /^[^\n]+/,
  };
})();

// ------------------------------------------------------------ inline rules

const INLINE = (() => {
  const punct = /[\p{P}\p{S}]/u;
  const punctSpace = /[\s\p{P}\p{S}]/u;
  const notPunctSpace = /[^\s\p{P}\p{S}]/u;
  // GFM punctuation classes: `~` counts as punctuation for `_` and `~~`
  // delimiters, but not for `*` delimiters.
  const punctNoTilde = /(?!~)[\p{P}\p{S}]/u;
  const punctSpaceNoTilde = /(?!~)[\s\p{P}\p{S}]/u;
  const notPunctSpaceOrTilde = /(?:[^\s\p{P}\p{S}]|~)/u;

  const anyPunctuation = edit(/\\(punct)/, 'gu').replace(/punct/g, punct).getRegex();
  const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
    .replace(/punct/g, punct)
    .getRegex();
  const punctuation = edit(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, punctSpace).getRegex();

  const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
  const codeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
  const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

  const htmlCommentClosed = edit(HTML_COMMENT).replace('(?:-->|$)', '-->').getRegex();
  const tagRe = edit(
    '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  )
    .replace('comment', htmlCommentClosed)
    .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
    .getRegex();

  const schemeRe = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
  const emailLocal = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
  const autolinkRe = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .replace('scheme', schemeRe)
    .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
    .getRegex();

  const bracketLabel = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
  const labelInner = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
    .replace('brackets', bracketLabel)
    .getRegex();
  const linkRe = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .replace('label', labelInner)
    .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
    .getRegex();
  const reflinkRe = edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', labelInner)
    .replace('ref', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)
    .getRegex();
  const nolinkRe = edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)
    .getRegex();

  // Emphasis left-delimiter: a run of `*` or `_` plus the char after it.
  const emStrongLeftSrc = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
  const emStrongLDelim = edit(emStrongLeftSrc, 'u').replace(/punct/g, punctNoTilde).getRegex();
  // Right-delimiter scanners: runs of `*` / `_` preceded by a char class.
  // Groups 1-2 are closers after punctuation / non-punctuation, groups 3-4
  // are runs that cannot close (they extend the opener count), groups 5-6
  // are closers that the rule of 3 may still veto.
  const rDelimAstSrc =
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
  const rDelimUndSrc =
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
  const emStrongRDelimAst = edit(rDelimAstSrc, 'gu')
    .replace(/notPunctSpace/g, notPunctSpaceOrTilde)
    .replace(/punctSpace/g, punctSpaceNoTilde)
    .replace(/punct/g, punctNoTilde)
    .getRegex();
  const emStrongRDelimUnd = edit(rDelimUndSrc, 'gu')
    .replace(/notPunctSpace/g, notPunctSpaceOrTilde)
    .replace(/punctSpace/g, punctSpaceNoTilde)
    .replace(/punct/g, punctNoTilde)
    .getRegex();

  const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, punct).getRegex();
  const delRDelimSrc =
    '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
  const delRDelim = edit(delRDelimSrc, 'gu')
    .replace(/notPunctSpace/g, notPunctSpace)
    .replace(/punctSpace/g, punctSpace)
    .replace(/punct/g, punct)
    .getRegex();
  const delRe = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\s\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

  const protocolRe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
  const emailProto = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, emailLocal).getRegex();
  const urlRe = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .replace('emailProtocol', emailProto)
    .replace('protocol', protocolRe)
    .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
    .getRegex();
  const backpedalRe = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

  const textRe = edit(
    /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  )
    .replace('protocol', protocolRe)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', HAS_LOOKBEHIND ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
    .getRegex();

  // Mask helpers for emphasis scanning.
  const blockSkipRe = edit(/link|precode-code|html/, 'g')
    .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
    .replace('precode-', HAS_LOOKBEHIND ? '(?<!`)()' : '(^^|[^`])')
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace('html', /<(?! )[^<>]*?>/)
    .getRegex();
  const labelLong = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
    .replace('brackets', bracketLabel)
    .getRegex();
  const refShort = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
  const reflinkSearchRe = edit('reflink|nolink(?!\\()', 'g')
    .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/).replace('label', labelLong).replace('ref', refShort).getRegex())
    .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', refShort).getRegex())
    .getRegex();

  return {
    escape: escapeRe,
    tag: tagRe,
    link: linkRe,
    reflink: reflinkRe,
    nolink: nolinkRe,
    emStrongLDelim,
    emStrongRDelimAst,
    emStrongRDelimUnd,
    codespan: codeRe,
    br: brRe,
    del: delRe,
    delLDelim,
    delRDelim,
    autolink: autolinkRe,
    url: urlRe,
    _backpedal: backpedalRe,
    text: textRe,
    blockSkip: blockSkipRe,
    reflinkSearch: reflinkSearchRe,
    anyPunctuation,
    anyPunctuationOutsideCode,
    punctuation,
  };
})();

// ------------------------------------------- delimiter scanning (em/del)

// A tokenizer keeps a stack (one entry per nested inline parse) of the
// last positions where an emphasis / strikethrough closer could still be
// found in the masked source. Inner parses push, then pop, so they never
// corrupt the outer parse's positions.
const delimiterStacks = new WeakMap();

function scanDelimiters(masked) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const ch = masked[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === ch; i++) {}
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = s;
      else lastEm[ch] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: masked, lastEm, lastDel };
}

function pushDelimiters(tokenizer, masked) {
  const entry = scanDelimiters(masked);
  const stack = delimiterStacks.get(tokenizer);
  if (stack) stack.push(entry);
  else delimiterStacks.set(tokenizer, [entry]);
}

function popDelimiters(tokenizer) {
  const stack = delimiterStacks.get(tokenizer);
  if (stack) {
    stack.pop();
    if (stack.length === 0) delimiterStacks.delete(tokenizer);
  }
}

function lastEmStrongIndex(tokenizer, masked, delim) {
  const top = delimiterStacks.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === masked) return top.lastEm[delim];
  return scanDelimiters(masked).lastEm[delim];
}

function lastDelIndex(tokenizer, masked) {
  const top = delimiterStacks.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === masked) return top.lastDel;
  return scanDelimiters(masked).lastDel;
}

// ------------------------------------------------------------ link helpers

// Does the link text `text` (starting at `offset` in the full remaining
// source `src`) contain a raw HTML tag or autolink that would run past the
// text's end? Such a link is not a link at all.
function linkTextHasTag(src, text, offset, rules) {
  if (!text.includes('<')) return false;
  for (let s = 0; s < text.length; s++) {
    if (text[s] === '\\') {
      s++;
      continue;
    }
    if (text[s] === '`') {
      const code = rules.inline.codespan.exec(text.slice(s));
      if (code) {
        s += code[0].length - 1;
        continue;
      }
    }
    if (text[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const tag = rules.inline.tag.exec(rest) || rules.inline.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > text.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

// Turn a matched link / image / reference link into its token, parsing the
// link text inline. A link whose text already contains a link is dropped
// (returns undefined), and the lexer state is restored around the parse.
function outputLink(cap, link, raw, lexer, rules) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(RX.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const prevInLink = lexer.state.inLink;
  const prevEmitted = lexer.state.linkEmitted;
  const prevRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const nestedEmitted = lexer.state.linkEmitted;
  lexer.state.linkEmitted = prevEmitted;
  lexer.state.inLink = prevInLink;
  if (!isImage) {
    if (nestedEmitted) {
      lexer.state.inRawBlock = prevRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

// Compensate fenced-code indentation: when the opening fence is indented,
// the same amount of leading whitespace is removed from each content line.
function compensateFenceIndent(raw, text, rules) {
  const m = raw.match(RX.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = line.match(RX.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// ---------------------------------------------------------------- Tokenizer

class Tokenizer {
  constructor() {
    this.rules = { block: BLOCK, inline: INLINE, other: RX };
    this.lexer = null;
  }

  // -- block tokenizers, tried in order by the lexer --

  space(src) {
    const cap = this.rules.block.newline.exec(src);
    if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
    return undefined;
  }

  code(src) {
    const cap = this.rules.block.code.exec(src);
    if (!cap) return undefined;
    const raw = stripTrailingBlanks(cap[0]);
    // stripTrailingBlanks keeps at most one trailing blank line; marked's
    // helper returns the input unchanged when at most two lines are blank
    // at the end, which for indented code is the same result.
    const text = raw.replace(this.rules.other.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }

  fences(src) {
    const cap = this.rules.block.fences.exec(src);
    if (!cap) return undefined;
    const raw = cap[0];
    const text = compensateFenceIndent(raw, cap[3] || '', this.rules);
    const lang = cap[2] ? cap[2].trim().replace(this.rules.inline.anyPunctuation, '$1') : cap[2];
    return { type: 'code', raw, lang, text };
  }

  heading(src) {
    const cap = this.rules.block.heading.exec(src);
    if (!cap) return undefined;
    let text = cap[2].trim();
    if (this.rules.other.endingHash.test(text)) {
      const stripped = rtrim(text, '#');
      if (!stripped || this.rules.other.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[1].length,
      text,
      tokens: this.lexer.inline(text),
    };
  }

  hr(src) {
    const cap = this.rules.block.hr.exec(src);
    if (!cap) return undefined;
    return { type: 'hr', raw: rtrim(cap[0], '\n') };
  }

  blockquote(src) {
    const cap = this.rules.block.blockquote.exec(src);
    if (!cap) return undefined;
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    const other = this.rules.other;
    while (lines.length > 0) {
      let inQuote = false;
      const group = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (other.blockquoteStart.test(lines[p])) {
          group.push(lines[p]);
          inQuote = true;
        } else if (!inQuote) {
          group.push(lines[p]);
        } else {
          break;
        }
      }
      lines = lines.slice(p);
      const joined = group.join('\n');
      const cleaned = joined
        .replace(other.blockquoteMarkerWhitespace, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(other.blockquoteSetextReplace, '\n    $1')
        .replace(other.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${joined}` : joined;
      text = text ? `${text}\n${cleaned}` : cleaned;
      const prevTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(cleaned, tokens, true);
      this.lexer.state.top = prevTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (
        last?.type === 'code' ||
        last?.type === 'heading' ||
        last?.type === 'hr' ||
        last?.type === 'html' ||
        last?.type === 'table'
      ) {
        break;
      }
      if (last?.type === 'blockquote') {
        const inner = last;
        const rest = lines.join('\n');
        const merged = inner.raw + '\n' + rest.replace(other.blockquoteSetextReplace2, '');
        const reparsed = this.blockquote(merged);
        tokens[tokens.length - 1] = reparsed;
        const tail = merged.substring(reparsed.raw.length).replace(/^\n/, '');
        const tailLines = tail ? tail.split('\n').length : 0;
        const consumed = tailLines ? lines.slice(0, -tailLines) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - inner.text.length) + reparsed.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const inner = last;
        const merged = inner.raw + '\n' + lines.join('\n');
        const reparsed = this.list(merged);
        tokens[tokens.length - 1] = reparsed;
        const extra =
          reparsed.raw.length > inner.raw.length
            ? merged.slice(inner.raw.length + 1, reparsed.raw.length).split('\n').length
            : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${taken}`;
          text = `${text}\n${taken}`;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    const cap = this.rules.block.list.exec(src);
    if (!cap) return undefined;
    const input = src;
    const startLen = src.length;
    const consumed = () => startLen - src.length;
    const first = cap[1].trim();
    const ordered = first.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +first.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    let bullet = ordered ? `\\d{1,9}\\${first.slice(-1)}` : `\\${first}`;
    const itemRe = this.rules.other.listItemRegex(bullet);
    const other = this.rules.other;
    const block = this.rules.block;
    let separated = false;
    while (src) {
      let itemEmpty = false;
      let itemText = '';
      const itemCap = itemRe.exec(src);
      if (!itemCap || block.hr.test(src)) break;
      const itemStart = consumed();
      src = src.substring(itemCap[0].length);
      const firstLine = itemCap[2].split('\n', 1)[0];
      const markerLen = itemCap[1].length;
      let content = firstLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, markerLen));
      let nextLine = src.split('\n', 1)[0];
      let emptyContent = !content.trim();
      let indent = 0;
      if (emptyContent) {
        indent = markerLen + 1;
      } else {
        indent = content.search(other.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemText = content.slice(indent);
        indent += markerLen;
      }
      if (emptyContent && other.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        itemEmpty = true;
      }
      if (!itemEmpty) {
        const nextBullet = other.nextBulletRegex(indent);
        const hrAt = other.hrRegex(indent);
        const fencesAt = other.fencesBeginRegex(indent);
        const headingAt = other.headingBeginRegex(indent);
        const htmlAt = other.htmlBeginRegex(indent);
        const quoteAt = other.blockquoteBeginRegex(indent);
        while (src) {
          const line = src.split('\n', 1)[0];
          nextLine = line;
          const expanded = line.replace(other.leadingSpaceTab, (ws) => expandTabs(ws));
          const startCh = lineStartChar(line);
          const canFence = startCh === '`' || startCh === '~';
          const canHeading = startCh === '#';
          const canHtml = startCh === '<';
          const canQuote = startCh === '>';
          const canBullet =
            startCh === '*' || startCh === '-' || startCh === '+' || (startCh >= '0' && startCh <= '9');
          const canHr = startCh === '-' || startCh === '_' || startCh === '*';
          if (
            (canFence && fencesAt.test(line)) ||
            (canHeading && headingAt.test(line)) ||
            (canHtml && htmlAt.test(line)) ||
            (canQuote && quoteAt.test(line)) ||
            (canBullet && nextBullet.test(line)) ||
            (canHr && hrAt.test(line))
          ) {
            break;
          }
          if (expanded.search(other.nonSpaceChar) >= indent || !line.trim()) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            const contentCh = lineStartChar(content);
            if (
              emptyContent ||
              content.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4 ||
              ((contentCh === '`' || contentCh === '~') && fencesAt.test(content)) ||
              (contentCh === '#' && headingAt.test(content)) ||
              (contentCh === '<' && htmlAt.test(content)) ||
              ((contentCh === '-' || contentCh === '_' || contentCh === '*') && hrAt.test(content))
            ) {
              break;
            }
            const setext =
              /^ {0,3}(?:=+|-+) *$/.test(line) && block.lheading.test(`${content}\n${line}`)
                ? `    ${expanded.replace(/^ {0,3}/, '')}`
                : line;
            itemText += '\n' + setext;
          }
          emptyContent = !line.trim();
          src = src.substring(line.length + 1);
          content = expanded.slice(indent);
        }
      }
      const raw = input.slice(itemStart, consumed());
      if (!list.loose) {
        if (separated) list.loose = true;
        else if (other.doubleBlankLine.test(raw)) separated = true;
      }
      list.items.push({
        type: 'list_item',
        raw,
        task: other.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return undefined;
    }
    list.raw = input.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        list.loose = spaces.length > 0 && spaces.some((t) => other.anyLine.test(t.raw));
      }
    }
    for (const item of list.items) {
      const firstTok = item.tokens[0];
      if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
        item.text = item.text.replace(other.listReplaceTask, '');
        firstTok.raw = firstTok.raw.replace(other.listReplaceTask, '');
        firstTok.text = firstTok.text.replace(other.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(other.listReplaceTask, '');
            break;
          }
        }
        const check = other.listTaskCheckbox.exec(item.raw);
        if (check) {
          const box = { type: 'checkbox', raw: check[0] + ' ', checked: check[0] !== '[ ]' };
          item.checked = box.checked;
          if (list.loose) {
            if (
              item.tokens[0] &&
              ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = box.raw + item.tokens[0].raw;
              item.tokens[0].text = box.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
    return list;
  }

  html(src) {
    const cap = this.rules.block.html.exec(src);
    if (!cap) return undefined;
    const raw = stripTrailingBlanks(cap[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }

  def(src) {
    const cap = this.rules.block.def.exec(src);
    if (!cap) return undefined;
    if (!this.rules.other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
      return undefined;
    }
    const tag = normalizeLabel(cap[1]);
    const href = cap[2]
      ? cap[2].replace(this.rules.other.hrefBrackets, '$1').replace(this.rules.inline.anyPunctuation, '$1')
      : '';
    const title = cap[3]
      ? cap[3].substring(1, cap[3].length - 1).replace(this.rules.inline.anyPunctuation, '$1')
      : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }

  table(src) {
    const cap = this.rules.block.table.exec(src);
    if (!cap || !this.rules.other.tableDelimiter.test(cap[2])) return undefined;
    const headerCells = splitCells(cap[1]);
    const alignParts = cap[2].replace(this.rules.other.tableAlignChars, '').split('|');
    const bodyLines = cap[3]?.trim() ? cap[3].replace(this.rules.other.tableRowBlankLine, '').split('\n') : [];
    const table = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== alignParts.length) return undefined;
    for (const part of alignParts) {
      if (this.rules.other.tableAlignRight.test(part)) table.align.push('right');
      else if (this.rules.other.tableAlignCenter.test(part)) table.align.push('center');
      else if (this.rules.other.tableAlignLeft.test(part)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({
        text: headerCells[i],
        tokens: this.lexer.inline(headerCells[i]),
        header: true,
        align: table.align[i],
      });
    }
    for (const line of bodyLines) {
      table.rows.push(
        splitCells(line, table.header.length).map((cell, i) => ({
          text: cell,
          tokens: this.lexer.inline(cell),
          header: false,
          align: table.align[i],
        })),
      );
    }
    return table;
  }

  lheading(src) {
    const cap = this.rules.block.lheading.exec(src);
    if (!cap) return undefined;
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: this.lexer.inline(text),
    };
  }

  paragraph(src) {
    const cap = this.rules.block.paragraph.exec(src);
    if (!cap) return undefined;
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: this.lexer.inline(text) };
  }

  text(src) {
    const cap = this.rules.block.text.exec(src);
    if (!cap) return undefined;
    return { type: 'text', raw: cap[0], text: cap[0], tokens: this.lexer.inline(cap[0]) };
  }

  // -- inline tokenizers, tried in order by the lexer --

  escape(src) {
    const cap = this.rules.inline.escape.exec(src);
    if (!cap) return undefined;
    return { type: 'escape', raw: cap[0], text: cap[1] };
  }

  tag(src) {
    const cap = this.rules.inline.tag.exec(src);
    if (!cap) return undefined;
    const state = this.lexer.state;
    const other = this.rules.other;
    if (!state.inLink && other.startATag.test(cap[0])) state.inLink = true;
    else if (state.inLink && other.endATag.test(cap[0])) state.inLink = false;
    if (!state.inRawBlock && other.startPreScriptTag.test(cap[0])) state.inRawBlock = true;
    else if (state.inRawBlock && other.endPreScriptTag.test(cap[0])) state.inRawBlock = false;
    return {
      type: 'html',
      raw: cap[0],
      inLink: state.inLink,
      inRawBlock: state.inRawBlock,
      block: false,
      text: cap[0],
    };
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return undefined;
    const cap = this.rules.inline.link.exec(src);
    if (!cap) return undefined;
    const offset = cap[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasTag(src, cap[1], offset, this.rules)) return undefined;
    const dest = cap[2].trim();
    if (this.rules.other.startAngleBracket.test(dest)) {
      if (!this.rules.other.endAngleBracket.test(dest)) return undefined;
      const stripped = rtrim(dest.slice(0, -1), '\\');
      if ((dest.length - stripped.length) % 2 === 0) return undefined;
    } else {
      const close = findClosingBracket(cap[2], '()');
      if (close === -2) return undefined;
      if (close > -1) {
        const cut = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + close;
        cap[2] = cap[2].substring(0, close);
        cap[0] = cap[0].substring(0, cut).trim();
        cap[3] = '';
      }
    }
    const tail = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - tail.length) % 2 === 0) return undefined;
    let href = cap[2];
    const title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (this.rules.other.startAngleBracket.test(href)) href = href.slice(1, -1);
    return outputLink(
      cap,
      {
        href: href && href.replace(this.rules.inline.anyPunctuation, '$1'),
        title: title && title.replace(this.rules.inline.anyPunctuation, '$1'),
      },
      cap[0],
      this.lexer,
      this.rules,
    );
  }

  reflink(src, links) {
    const cap = this.rules.inline.reflink.exec(src) || this.rules.inline.nolink.exec(src);
    if (!cap) return undefined;
    const offset = cap[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasTag(src, cap[1], offset, this.rules)) return undefined;
    const ref = links[normalizeLabel(cap[2] || cap[1])];
    if (!ref) {
      const ch = cap[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return outputLink(cap, ref, cap[0], this.lexer, this.rules);
  }

  emStrong(src, masked, prev = '') {
    const cap = this.rules.inline.emStrongLDelim.exec(src);
    if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return undefined;
    const delim = cap[0][0];
    const prevIsDelim = prev === delim;
    const offset = masked.length - src.length;
    let runStart = offset;
    for (; runStart > 0 && masked[runStart - 1] === delim;) runStart--;
    let before = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsPunct = before === '*' || before === '_' || !!this.rules.inline.punctuation.exec(before);
    if (runStart < offset) prev = before;
    const canOpen = runStart < offset ? beforeIsPunct : !!this.rules.inline.punctuation.exec(prev);
    if (cap[4] && prev.match(this.rules.other.unicodeAlphaNumeric)) return undefined;
    const afterPunct = cap[1] || cap[3] || '';
    if (!afterPunct || !prev || canOpen) {
      const runLen = [...cap[0]].length - 1;
      let open = runLen;
      let extra = 0;
      const fromRunStart = offset - runStart + runLen;
      const canCloseAlone =
        !!before.trim() && (!!afterPunct || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return undefined;
      const closerRe =
        delim === '*' ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      const lastCloser = lastEmStrongIndex(this.lexer.tokenizer, masked, delim);
      const needFrom = offset + runLen;
      if (lastCloser < needFrom) return undefined;
      const rest = masked.slice(-src.length + runLen);
      const limit = lastCloser - needFrom;
      let match;
      for (closerRe.lastIndex = 0; (match = closerRe.exec(rest)) !== null && !(match.index > limit);) {
        const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!run) continue;
        const len = [...run].length;
        if (match[3] || match[4]) {
          open += len;
          continue;
        } else if (match[5] || match[6] || canCloseAlone) {
          if (prevIsDelim && (match[5] || match[6])) break;
          if (fromRunStart % 3 && !((fromRunStart + len) % 3)) {
            extra += len;
            continue;
          }
        }
        open -= len;
        if (open > 0) continue;
        const take = Math.min(len, len + open + extra);
        const firstLen = [...match[0]][0].length;
        const raw = src.slice(0, runLen + match.index + firstLen + take);
        if (Math.min(runLen, take) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  codespan(src) {
    const cap = this.rules.inline.codespan.exec(src);
    if (!cap) return undefined;
    let text = cap[2].replace(this.rules.other.newLineCharGlobal, ' ');
    const hasNonSpace = this.rules.other.nonSpaceChar.test(text);
    const padded =
      this.rules.other.startingSpaceChar.test(text) && this.rules.other.endingSpaceChar.test(text);
    if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }

  br(src) {
    const cap = this.rules.inline.br.exec(src);
    if (!cap) return undefined;
    return { type: 'br', raw: cap[0] };
  }

  del(src, masked, prev = '') {
    const cap = this.rules.inline.delLDelim.exec(src);
    if (!cap) return undefined;
    if (!(cap[1] || '') || !prev || this.rules.inline.punctuation.exec(prev)) {
      const runLen = [...cap[0]].length - 1;
      let open = runLen;
      const closerRe = this.rules.inline.delRDelim;
      const lastCloser = lastDelIndex(this.lexer.tokenizer, masked);
      const needFrom = masked.length - src.length + runLen;
      if (lastCloser < needFrom) return undefined;
      const rest = masked.slice(-src.length + runLen);
      const limit = lastCloser - needFrom;
      let match;
      for (closerRe.lastIndex = 0; (match = closerRe.exec(rest)) !== null && !(match.index > limit);) {
        const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!run) continue;
        let len = [...run].length;
        if (len !== runLen) continue;
        if (match[3] || match[4]) {
          open += len;
          continue;
        }
        open -= len;
        if (open > 0) continue;
        len = Math.min(len, len + open);
        const firstLen = [...match[0]][0].length;
        const raw = src.slice(0, runLen + match.index + firstLen + len);
        const inner = raw.slice(runLen, -runLen);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  autolink(src) {
    const cap = this.rules.inline.autolink.exec(src);
    if (!cap) return undefined;
    let text;
    let href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }

  url(src) {
    const cap = this.rules.inline.url.exec(src);
    if (!cap) return undefined;
    let text;
    let href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prev = cap[0];
      do {
        prev = cap[0];
        cap[0] = this.rules.inline._backpedal.exec(cap[0])?.[0] ?? '';
      } while (prev !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }

  inlineText(src) {
    const cap = this.rules.inline.text.exec(src);
    if (!cap) return undefined;
    const inRaw = this.lexer.state.inRawBlock;
    return { type: 'text', raw: cap[0], text: inRaw ? cap[0] : unescapeHtml(cap[0]), escaped: inRaw };
  }
}

// ------------------------------------------------------------------- Lexer

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer();
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  static lex(src) {
    return new Lexer().lex(src);
  }

  static lexInline(src) {
    return new Lexer().inlineTokens(src);
  }

  lex(src) {
    src = src.replace(RX.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (const queued of this.inlineQueue) {
      this.state.inRawBlock = false;
      this.inlineTokens(queued.src, queued.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens = [], nested = false) {
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    let nestedFlag = nested;
    for (; src;) {
      if (src.length < shortest) shortest = src.length;
      else this.infiniteLoopError(src.charCodeAt(0));
      let token;
      if ((token = this.tokenizer.space(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (token.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.code(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if ((token = this.tokenizer.fences(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.heading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.hr(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.blockquote(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.list(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.html(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.def(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.tokens.links[token.tag]) {
            this.tokens.links[token.tag] = { href: token.href, title: token.title };
          }
          tokens.push(token);
        }
        continue;
      }
      if ((token = this.tokenizer.table(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.lheading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (this.state.top && (token = this.tokenizer.paragraph(src))) {
        const prev = tokens.at(-1);
        if (nestedFlag && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(token);
        }
        nestedFlag = false;
        src = src.substring(token.raw.length);
        continue;
      }
      if ((token = this.tokenizer.text(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (src) this.infiniteLoopError(src.charCodeAt(0));
      break;
    }
    this.state.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  linkInText(src) {
    if (!src.includes('[')) return false;
    const linkRe = this.tokenizer.rules.inline.link;
    for (const m of src.matchAll(this.tokenizer.rules.inline.blockSkip)) {
      if (linkRe.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      const whole = m[0];
      const open = whole.lastIndexOf('[');
      if (
        !(whole.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(whole.slice(open + 1, -1)))) &&
        !(open > 1 && this.linkInText(whole.slice(1, open - 1)))
      ) {
        return true;
      }
    }
    return false;
  }

  inlineTokens(src, tokens = []) {
    const prevParen = this.state.linkParenPossible;
    this.state.linkParenPossible = prevParen && src.includes(')');
    try {
      return this.inlineWithMask(src, tokens);
    } finally {
      this.state.linkParenPossible = prevParen;
    }
  }

  inlineWithMask(src, tokens) {
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? this.maskEmStrong(src) : src;
    pushDelimiters(this.tokenizer, masked);
    try {
      return this.inlineScan(src, masked, tokens);
    } finally {
      popDelimiters(this.tokenizer);
    }
  }

  inlineScan(src, masked, tokens) {
    let inText = false;
    let lastChar = '';
    let shortest = Infinity;
    for (; src;) {
      if (src.length < shortest) shortest = src.length;
      else this.infiniteLoopError(src.charCodeAt(0));
      if (!inText) lastChar = '';
      inText = false;
      let token;
      if ((token = this.tokenizer.escape(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.tag(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.link(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.reflink(src, this.tokens.links))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (token.type === 'text' && prev?.type === 'text') {
          prev.raw += token.raw;
          prev.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if ((token = this.tokenizer.emStrong(src, masked, lastChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.codespan(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.br(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.del(src, masked, lastChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.autolink(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (!this.state.inLink && (token = this.tokenizer.url(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.inlineText(src))) {
        src = src.substring(token.raw.length);
        if (token.raw.slice(-1) !== '_') lastChar = token.raw.slice(-1);
        inText = true;
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += token.raw;
          prev.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (src) this.infiniteLoopError(src.charCodeAt(0));
      break;
    }
    return tokens;
  }

  // Build the masked copy of `src` that emphasis scanning reads: link
  // texts, code spans and backslash-escaped punctuation are neutralized
  // (replaced by length-preserving filler) so delimiters inside them
  // cannot open or close emphasis.
  maskEmStrong(src) {
    let masked = src;
    const inline = this.tokenizer.rules.inline;
    if (this.tokens.links && src.includes('[')) {
      const search = inline.reflinkSearch;
      const maskRef = (match) => {
        const open = match.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match.slice(open + 1, -1)))) return match;
        if (open > 1 && match.charAt(0) !== '!') {
          const inner = match.slice(1, open - 1);
          if (this.linkInText(inner)) {
            return '[' + inner.replace(search, maskRef) + '][' + 'a'.repeat(match.length - open - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match.length - 2) + ']';
      };
      masked = masked.replace(search, maskRef);
    }
    // The punctuation mask only matches code spans (backtick) or a
    // backslash before punctuation; without either it is a no-op.
    if (masked.includes('`') || masked.includes('\\')) {
      masked = masked.replace(inline.anyPunctuationOutsideCode, (whole, ticks, punct) =>
        punct
          ? '+'.repeat(whole.length)
          : ticks
            ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
            : whole,
      );
    }
    // The block-skip pattern can only match a link (`](`), a code span
    // (backtick) or raw HTML (`<`); without any of those it is a no-op.
    if (masked.includes('](') || masked.includes('`') || masked.includes('<')) {
      masked = masked.replace(inline.blockSkip, (whole, _g1, g2) => {
        const keep = g2 ? g2.length : 0;
        return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
      });
    }
    return masked;
  }

  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte);
  }
}

// ----------------------------------------------------------------- Renderer

class Renderer {
  constructor() {
    this.parser = null;
  }

  space() {
    return '';
  }

  code(token) {
    const lang = (token.lang || '').match(RX.notSpaceStart)?.[0];
    const text = token.text ? token.text.replace(RX.endingNewline, '') + '\n' : '';
    const body = token.escaped ? text : escapeHtml(text, true);
    if (lang) return `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>\n`;
    return `<pre><code>${body}</code></pre>\n`;
  }

  blockquote(token) {
    return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
  }

  html(token) {
    return token.text;
  }

  def() {
    return '';
  }

  heading(token) {
    return `<h${token.depth}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
  }

  hr() {
    return '<hr>\n';
  }

  list(token) {
    let out = '';
    for (const item of token.items) out += this.listitem(item);
    const tag = token.ordered ? 'ol' : 'ul';
    const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
    return `<${tag}${start}>\n${out}</${tag}>\n`;
  }

  listitem(token) {
    return `<li>${this.parser.parse(token.tokens)}</li>\n`;
  }

  checkbox(token) {
    return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  }

  paragraph(token) {
    return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
  }

  table(token) {
    let head = '';
    for (const cell of token.header) head += this.tablecell(cell);
    const headRow = this.tablerow({ text: head });
    let body = '';
    for (const row of token.rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
  }

  tablerow(token) {
    return `<tr>\n${token.text}</tr>\n`;
  }

  tablecell(token) {
    const inner = this.parser.parseInline(token.tokens);
    const tag = token.header ? 'th' : 'td';
    return (token.align ? `<${tag} align="${token.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }

  strong(token) {
    return `<strong>${this.parser.parseInline(token.tokens)}</strong>`;
  }

  em(token) {
    return `<em>${this.parser.parseInline(token.tokens)}</em>`;
  }

  codespan(token) {
    return `<code>${escapeHtml(token.text, true)}</code>`;
  }

  br() {
    return '<br>';
  }

  del(token) {
    return `<del>${this.parser.parseInline(token.tokens)}</del>`;
  }

  link(token) {
    const inner = token.autolink ? escapeHtml(token.text, true) : this.parser.parseInline(token.tokens);
    const href = cleanUrl(token.href);
    if (href === null) return inner;
    let out = '<a href="' + escapeHtml(href, token.autolink) + '"';
    if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
    return out + '>' + inner + '</a>';
  }

  image(token) {
    let alt = token.text;
    if (token.tokens) alt = this.parser.parseInline(token.tokens, this.parser.textRenderer);
    const src = cleanUrl(token.href);
    if (src === null) return escapeHtml(alt);
    let out = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"`;
    if (token.title) out += ` title="${escapeHtml(token.title)}"`;
    return out + '>';
  }

  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
    if ('escaped' in token && token.escaped) return token.text;
    return escapeHtml(token.text);
  }
}

// TextRenderer renders inline tokens to plain text (image alt text).
class TextRenderer {
  constructor() {
    this.parser = null;
  }

  strong(token) {
    return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text;
  }

  em(token) {
    return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text;
  }

  codespan(token) {
    return token.text;
  }

  del(token) {
    return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text;
  }

  html(token) {
    return token.text;
  }

  text(token) {
    return token.text;
  }

  link(token) {
    return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text;
  }

  image(token) {
    return token.tokens ? this.parser.parseInline(token.tokens, this) : token.text;
  }

  br() {
    return '';
  }

  checkbox(token) {
    return token.raw;
  }
}

// ------------------------------------------------------------------- Parser

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  static parse(tokens) {
    return new Parser().parse(tokens);
  }

  static parseInline(tokens) {
    return new Parser().parseInline(tokens);
  }

  parse(tokens) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space':
          out += this.renderer.space(token);
          break;
        case 'hr':
          out += this.renderer.hr(token);
          break;
        case 'heading':
          out += this.renderer.heading(token);
          break;
        case 'code':
          out += this.renderer.code(token);
          break;
        case 'table':
          out += this.renderer.table(token);
          break;
        case 'blockquote':
          out += this.renderer.blockquote(token);
          break;
        case 'list':
          out += this.renderer.list(token);
          break;
        case 'checkbox':
          out += this.renderer.checkbox(token);
          break;
        case 'html':
          out += this.renderer.html(token);
          break;
        case 'def':
          out += this.renderer.def(token);
          break;
        case 'paragraph':
          out += this.renderer.paragraph(token);
          break;
        case 'text':
          out += this.renderer.text(token);
          break;
        default:
          throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'escape':
          out += renderer.text(token);
          break;
        case 'html':
          out += renderer.html(token);
          break;
        case 'link':
          out += renderer.link(token);
          break;
        case 'image':
          out += renderer.image(token);
          break;
        case 'checkbox':
          out += renderer.checkbox(token);
          break;
        case 'strong':
          out += renderer.strong(token);
          break;
        case 'em':
          out += renderer.em(token);
          break;
        case 'codespan':
          out += renderer.codespan(token);
          break;
        case 'br':
          out += renderer.br(token);
          break;
        case 'del':
          out += renderer.del(token);
          break;
        case 'text':
          out += renderer.text(token);
          break;
        default:
          throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  }
}

// --------------------------------------------------------------------- entry

// Render `markdown` to HTML, exactly as marked 18.1.3 does with its
// defaults. Each call is independent: nothing is kept between calls.
export function parse(markdown) {
  return Parser.parse(Lexer.lex(markdown));
}
