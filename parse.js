// Fast Markdown renderer — a from-scratch reimplementation of the algorithm
// marked 18.1.3 uses with its default options (GFM on, breaks off).
// Written fresh for make.fun's markdown-render-speed-02 bounty.
// Architecture: block lexer -> inline lexer -> renderer (+ a plain-text
// renderer for image alt text). No dependency on marked at runtime, no
// lookup of any case's HTML, no caching between cases.
//
// `parse(markdown)` lexes the document into tokens, then renders them.
// Everything below is built for the GFM default configuration only.

/** Build a composite regex by substituting named fragments into a source. */
const CARET = /(^|[^\[])\^/g;
function edit(source, flags = '') {
  let text = typeof source === 'string' ? source : source.source;
  const api = {
    replace(name, value) {
      let sub = typeof value === 'string' ? value : value.source;
      sub = sub.replace(CARET, '$1');
      text = text.replace(name, sub);
      return api;
    },
    getRegex() {
      return new RegExp(text, flags);
    },
  };
  return api;
}

/** Memoize an indent-dependent regex factory (indent clamped to 0..3). */
function memoIndent(make) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = make(i));
  };
}

const R = {
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
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: CARET,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bullet) =>
    new RegExp(`^( {0,3}${bullet})((?:[	 ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: memoIndent(
    (n) =>
      new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`),
  ),
  hrRegex: memoIndent(
    (n) =>
      new RegExp(
        `^ {0,${n}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`,
      ),
  ),
  fencesBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memoIndent(
    (n) =>
      new RegExp(
        `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        'i',
      ),
  ),
  blockquoteBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}>`)),
};

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---- Block rules (GFM set) ----

const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE =
  /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR =
  /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_TEXT = /^[^\n]+/;

const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// Setext heading: the lookahead names are substituted by the builder.
const SETTEXT_TEMPLATE =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
function buildSetext(tableFragment) {
  return edit(SETTEXT_TEMPLATE)
    .replace(/bull/g, BULLET)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    // Non-capturing form: the capturing hr pattern would shift the
    // setext match groups (the text and underline land in m[1]/m[2]).
    .replace(
      /hr/g,
      / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
    )
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, tableFragment)
    .getRegex();
}
const BLOCK_LHEADING = buildSetext(/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/);

// Paragraph: a run of lines, stopping before a block start.
const PARAGRAPH_TEMPLATE =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listFragment, tableFragment) {
  const builder = edit(PARAGRAPH_TEMPLATE)
    .replace('hr', BLOCK_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '');
  // With a table pattern, substitute it for the `table` alternative;
  // without one, drop the whole `|table` alternative — leaving a bare
  // `|` would make the lookahead fail at every position.
  if (tableFragment === '' || tableFragment === null) {
    builder.replace('|table', '');
  } else {
    builder.replace('table', tableFragment);
  }
  return builder
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listFragment)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS)
    .getRegex();
}

// Link reference definition.
const LABEL_INNER =
  /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BLOCK_DEF = edit(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .replace('label', LABEL_INNER)
  .replace(
    'title',
    /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/,
  )
  .getRegex();

// Unordered/ordered list start.
const BLOCK_LIST = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, BULLET)
  .getRegex();

// HTML block.
const BLOCK_HTML = edit(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'i',
)
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace(
    'attribute',
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  )
  .getRegex();

// Blockquote: a run of `>` lines (with lazy continuation), whose inner
// text is re-lexed as blocks; the paragraph fragment inside is a
// paragraph regex that also stops at a list start.
const BLOCKQUOTE = edit(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
)
  .replace(
    'paragraph',
    buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, ''),
  )
  .getRegex();

// GFM table.
const BLOCK_TABLE = edit(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
)
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace(
    'html',
    ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  )
  .replace('tag', BLOCK_TAGS)
  .getRegex();

const BLOCK_PARAGRAPH = buildParagraph(
  ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]',
  BLOCK_TABLE,
);

const BLOCK = {
  blockquote: BLOCKQUOTE,
  code: BLOCK_CODE,
  def: BLOCK_DEF,
  fences: BLOCK_FENCES,
  heading: BLOCK_HEADING,
  hr: BLOCK_HR,
  html: BLOCK_HTML,
  lheading: BLOCK_LHEADING,
  list: BLOCK_LIST,
  newline: BLOCK_NEWLINE,
  paragraph: BLOCK_PARAGRAPH,
  table: BLOCK_TABLE,
  text: BLOCK_TEXT,
};

// ---- Inline rules (GFM set) ----

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

// Unicode punctuation classes. The `*` delimiters use the tilde-free
// variants; `_` and `~~` use the plain ones (where `~` counts as punct).
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

const INLINE_PUNCT_TEST = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, PUNCT_SPACE)
  .getRegex();

// Left-delimiter matchers for emphasis.
const EM_STRONG_LEFT_SRC =
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_STRONG_LEFT = edit(EM_STRONG_LEFT_SRC, 'u')
  .replace(/punct/g, PUNCT_NO_TILDE)
  .getRegex();

// Right-delimiter scanners. The pattern text is shared; the classes
// plugged in differ per delimiter (`*` tilde-free, `_`/`~~` plain).
const EM_STRONG_RIGHT_AST_SRC =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const EM_STRONG_RIGHT_AST = edit(EM_STRONG_RIGHT_AST_SRC, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .replace(/punctSpace/g, PUNCT_SPACE_NO_TILDE)
  .replace(/punct/g, PUNCT_NO_TILDE)
  .getRegex();
const EM_STRONG_RIGHT_UND = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)',
  'gu',
)
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

const DEL_LEFT = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .getRegex();
const DEL_RIGHT = edit(
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)',
  'gu',
)
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
const DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Backslash-punctuation, for stripping escapes.
const ANY_PUNCT = edit(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const ANY_PUNCT_OUTSIDE_CODE = edit(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  'gu',
)
  .replace(/punct/g, PUNCT)
  .getRegex();

// Autolink `<scheme:...>` / `<email>`.
const EMAIL_LOCAL =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const INLINE_AUTOLINK = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', EMAIL_LOCAL)
  .getRegex();

// Raw HTML tag (inline).
const INLINE_TAG = edit(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
)
  .replace(
    'comment',
    edit(HTML_COMMENT).replace('(?:-->|$)', '-->').getRegex(),
  )
  .replace(
    'attribute',
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  )
  .getRegex();

// The "skip" matcher used to mask links / code spans / tags when the
// emphasis scanner works out where delimiters may close.
const BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .replace(
    'link',
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  )
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

// Link text (balanced brackets, code spans allowed inside).
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL = edit(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
)
  .replace('brackets', BRACKETED)
  .getRegex();

const INLINE_LINK = edit(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
)
  .replace('label', LINK_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace(
    'title',
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
  )
  .getRegex();
const INLINE_REFLINK = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', LINK_LABEL)
  .replace('ref', LABEL_INNER)
  .getRegex();
const INLINE_NOLINK = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', LABEL_INNER)
  .getRegex();

// Search matcher for reference links (used while masking).
const REFLINK_LABEL_WIDE = edit(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
)
  .replace('brackets', BRACKETED)
  .getRegex();
const REFLINK_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_SEARCH = edit('reflink|nolink(?!\\()', 'g')
  .replace(
    'reflink',
    edit(/^!?\[(label)\]\[(ref)\]/)
      .replace('label', REFLINK_LABEL_WIDE)
      .replace('ref', REFLINK_REF)
      .getRegex(),
  )
  .replace(
    'nolink',
    edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', REFLINK_REF).getRegex(),
  )
  .getRegex();

// GFM extended autolinks: www. / scheme:// / bare email.
const SCHEME = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_GFM =
  /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const MAILTO_XMPP = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EMAIL_GFM)
  .getRegex();
const INLINE_URL = edit(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
)
  .replace('emailProtocol', MAILTO_XMPP)
  .replace('protocol', SCHEME)
  .replace(
    'email',
    /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  )
  .getRegex();
const URL_BACKPEDAL =
  /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Plain inline text (GFM): stops before any inline construct.
const INLINE_TEXT = edit(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
)
  .replace('protocol', SCHEME)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

const INLINE = {
  anyPunctuation: ANY_PUNCT,
  anyPunctuationOutsideCode: ANY_PUNCT_OUTSIDE_CODE,
  autolink: INLINE_AUTOLINK,
  backpedal: URL_BACKPEDAL,
  blockSkip: BLOCK_SKIP,
  br: INLINE_BR,
  code: INLINE_CODE,
  del: DEL,
  delLDelim: DEL_LEFT,
  delRDelim: DEL_RIGHT,
  emStrongLDelim: EM_STRONG_LEFT,
  emStrongRDelimAst: EM_STRONG_RIGHT_AST,
  emStrongRDelimUnd: EM_STRONG_RIGHT_UND,
  escape: INLINE_ESCAPE,
  link: INLINE_LINK,
  nolink: INLINE_NOLINK,
  punctuation: INLINE_PUNCT_TEST,
  reflink: INLINE_REFLINK,
  reflinkSearch: REFLINK_SEARCH,
  tag: INLINE_TAG,
  text: INLINE_TEXT,
  url: INLINE_URL,
};

// ---- Helpers ----

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape HTML chars; with `encode`, `&` is escaped unconditionally. */
function esc(value, encode = false) {
  if (encode) {
    if (R.escapeTest.test(value)) return value.replace(R.escapeReplace, (c) => ESCAPE_MAP[c]);
  } else if (R.escapeTestNoEncode.test(value)) {
    return value.replace(R.escapeReplaceNoEncode, (c) => ESCAPE_MAP[c]);
  }
  return value;
}

/** Resolve numeric character references; lone `&` becomes `&amp;`. */
function unesc(value) {
  if (!R.numericCharacterReference.test(value)) return value;
  return value.replace(
    R.numericCharacterReferenceOrAmpersand,
    (whole, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const code =
        dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return '\uFFFD';
      }
      if (code === 38) return '&amp;';
      return String.fromCodePoint(code);
    },
  );
}

/** encodeURI a link target (`%25` is left as a literal percent). */
function cleanUrl(url) {
  try {
    return encodeURI(url).replace(R.percentDecode, '%');
  } catch {
    return null;
  }
}

/** Split a table row on unescaped pipes; pad/truncate to `count`. */
function splitCells(row, count) {
  const markedRow = row.replace(R.findPipe, (pipe, offset, str) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = markedRow.split(R.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) {
    cells.pop();
  }
  if (count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(R.slashPipe, '|');
  return cells;
}

/** Strip trailing characters: `ch` when `invert` is false, non-`ch` when true. */
function trimEndChars(str, ch, invert = false) {
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

/** Drop trailing blank lines, keeping at most one blank line at the end. */
function stripBlankTail(src) {
  const lines = src.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && R.blankLine.test(lines[last]);) last--;
  return lines.length - last <= 2 ? src : lines.slice(0, last + 1).join('\n');
}

/** Normalize a link label: trim, collapse whitespace, case-fold. */
function normLabel(label) {
  return label.trim().replace(R.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/**
 * Find the index of the unmatched closing paren, skipping `\(` / `\)`.
 * Returns -2 when a paren is left open, -1 when balanced (or none).
 */
function findParen(src, pair) {
  if (src.indexOf(pair[0]) === -1 && src.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === pair[0]) depth++;
    else if (src[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

/** Expand tabs to spaces, tracking the column from `start`. */
function expandTabs(str, start = 0) {
  let col = start;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const width = 4 - (col % 4);
      out += ' '.repeat(width);
      col += width;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/**
 * Dedent fenced-code content by the opening fence's indent. Only
 * backtick fences dedent (the compensation pattern only matches ```).
 */
function fenceDedent(raw, content) {
  const m = raw.match(R.indentCodeCompensation);
  if (m === null) return content;
  const indent = m[1];
  return content
    .split('\n')
    .map((line) => {
      const lead = line.match(R.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

/**
 * True when the link text contains a tag/autolink that runs past the end
 * of the text — such a link is not a link at all.
 */
function linkTextHasTag(full, text, offset) {
  if (!text.includes('<')) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '`') {
      const code = INLINE.code.exec(text.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (text[i] !== '<') continue;
    const rest = full.slice(offset + i);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > text.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

/**
 * Scan a (masked) inline source for the last position a closer could
 * start at, per delimiter. A run only counts when the char before it is
 * not whitespace. Recorded once per inline parse and stacked, so nested
 * parses don't disturb the outer scan.
 */
function scanDelimEnds(src) {
  const emEnds = { '*': -1, _: -1 };
  let delEnd = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const before = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    for (; j < n && src[j] === ch;) j++;
    if (
      before !== ' ' &&
      before !== '\t' &&
      before !== '\n' &&
      before !== '\r' &&
      before !== '\f'
    ) {
      if (ch === '~') delEnd = i;
      else emEnds[ch] = i;
    }
    i = j - 1;
  }
  return { masked: src, emEnds, delEnd };
}

// ---- Tokenizer ----
// Turns source text into tokens. Block methods take the remaining
// source and return a token (or undefined); inline methods do the same
// for inline source. `lexer` back-reference is set by the Lexer.

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (m) {
      const raw = stripBlankTail(m[0]);
      return {
        type: 'code',
        raw,
        codeBlockStyle: 'indented',
        text: raw.replace(R.codeRemoveIndent, ''),
      };
    }
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (m) {
      return {
        type: 'code',
        raw: m[0],
        lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
        text: fenceDedent(m[0], m[3] || ''),
      };
    }
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (R.endingHash.test(text)) {
        const stripped = trimEndChars(text, '#');
        if (!stripped || R.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return {
        type: 'heading',
        raw: trimEndChars(m[0], '\n'),
        depth: m[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: trimEndChars(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return undefined;
    let lines = trimEndChars(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let seenMarker = false;
      const group = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (R.blockquoteStart.test(lines[p])) {
          group.push(lines[p]);
          seenMarker = true;
        } else if (!seenMarker) group.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const joined = group.join('\n');
      const stripped = joined
        .replace(
          R.blockquoteMarkerWhitespace,
          (whole, marker, spaces) => marker + expandTabs(spaces, marker.length),
        )
        .replace(R.blockquoteSetextReplace, '\n    $1')
        .replace(R.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${joined}` : joined;
      text = text ? `${text}\n${stripped}` : stripped;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(stripped, tokens, true);
      this.lexer.state.top = savedTop;
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
        const combined =
          inner.raw + '\n' + rest.replace(R.blockquoteSetextReplace2, '');
        const reparsed = this.blockquote(combined);
        tokens[tokens.length - 1] = reparsed;
        const tail = combined.substring(reparsed.raw.length).replace(/^\n/, '');
        const tailCount = tail ? tail.split('\n').length : 0;
        const consumed = tailCount ? lines.slice(0, -tailCount) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - inner.text.length) + reparsed.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && R.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const listTok = last;
        const combined = listTok.raw + '\n' + lines.join('\n');
        const reparsed = this.list(combined);
        tokens[tokens.length - 1] = reparsed;
        const extra =
          reparsed.raw.length > listTok.raw.length
            ? combined.slice(listTok.raw.length + 1, reparsed.raw.length).split('\n').length
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
    const first = BLOCK.list.exec(src);
    if (!first) return undefined;
    const start = src;
    let rest = src;
    const used = () => start.length - rest.length;
    let bullet = first[1].trim();
    const ordered = bullet.length > 1;
    const listTok = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +bullet.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = R.listItemRegex(bullet);
    let sawDoubleBlank = false;
    let m;
    while (rest) {
      let emptyItem = false;
      let itemText = '';
      if (!(m = itemRe.exec(rest)) || BLOCK.hr.test(rest)) break;
      const itemStart = used();
      rest = rest.substring(m[0].length);
      const firstLine = m[2].split('\n', 1)[0];
      const bulletLen = m[1].length;
      let content = firstLine.replace(R.leadingSpaceTab, (v) =>
        expandTabs(v, bulletLen),
      );
      let nextLine = rest.split('\n', 1)[0];
      let emptyFirst = !content.trim();
      let indent = 0;
      if (emptyFirst) indent = bulletLen + 1;
      else {
        indent = content.search(R.nonSpaceChar);
        if (indent > 4) indent = 1;
        itemText = content.slice(indent);
        indent += bulletLen;
      }
      if (emptyFirst && R.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const nextBulletRe = R.nextBulletRegex(indent);
        const hrRe = R.hrRegex(indent);
        const fencesRe = R.fencesBeginRegex(indent);
        const headingRe = R.headingBeginRegex(indent);
        const htmlRe = R.htmlBeginRegex(indent);
        const quoteRe = R.blockquoteBeginRegex(indent);
        while (rest) {
          const line = rest.split('\n', 1)[0];
          let dedented;
          nextLine = line;
          dedented = line.replace(R.leadingSpaceTab, (v) => expandTabs(v));
          if (
            fencesRe.test(line) ||
            headingRe.test(line) ||
            htmlRe.test(line) ||
            quoteRe.test(line) ||
            nextBulletRe.test(line) ||
            hrRe.test(line)
          ) {
            break;
          }
          if (dedented.search(R.nonSpaceChar) >= indent || !line.trim()) {
            itemText += '\n' + dedented.slice(indent);
          } else {
            if (
              emptyFirst ||
              content.replace(R.tabCharGlobal, '    ').search(R.nonSpaceChar) >= 4 ||
              fencesRe.test(content) ||
              headingRe.test(content) ||
              htmlRe.test(content) ||
              hrRe.test(content)
            ) {
              break;
            }
            const setextLine =
              /^ {0,3}(?:=+|-+) *$/.test(line) &&
              BLOCK.lheading.test(`${content}\n${line}`)
                ? `    ${dedented.replace(/^ {0,3}/, '')}`
                : line;
            itemText += '\n' + setextLine;
          }
          emptyFirst = !line.trim();
          rest = rest.substring(line.length + 1);
          content = dedented.slice(indent);
        }
      }
      const itemRaw = start.slice(itemStart, used());
      if (!listTok.loose) {
        if (sawDoubleBlank) listTok.loose = true;
        else if (R.doubleBlankLine.test(itemRaw)) sawDoubleBlank = true;
      }
      listTok.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: R.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const tail = listTok.items.at(-1);
    if (tail) {
      tail.raw = tail.raw.trimEnd();
      tail.text = tail.text.trimEnd();
    } else {
      return undefined;
    }
    listTok.raw = start.slice(0, used()).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        listTok.loose =
          spaces.length > 0 && spaces.some((t) => R.anyLine.test(t.raw));
      }
    }
    for (const item of listTok.items) {
      const head = item.tokens[0];
      if (item.task && (head?.type === 'text' || head?.type === 'paragraph')) {
        item.text = item.text.replace(R.listReplaceTask, '');
        head.raw = head.raw.replace(R.listReplaceTask, '');
        head.text = head.text.replace(R.listReplaceTask, '');
        for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
          if (R.listIsTask.test(this.lexer.inlineQueue[i].src)) {
            this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(
              R.listReplaceTask,
              '',
            );
            break;
          }
        }
        const check = R.listTaskCheckbox.exec(item.raw);
        if (check) {
          const box = {
            type: 'checkbox',
            raw: check[0] + ' ',
            checked: check[0] !== '[ ]',
          };
          item.checked = box.checked;
          if (listTok.loose) {
            const firstTok = item.tokens[0];
            if (
              firstTok &&
              ['paragraph', 'text'].includes(firstTok.type) &&
              'tokens' in firstTok &&
              firstTok.tokens
            ) {
              firstTok.raw = box.raw + firstTok.raw;
              firstTok.text = box.raw + firstTok.text;
              firstTok.tokens.unshift(box);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: box.raw,
                text: box.raw,
                tokens: [box],
              });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return listTok;
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (m) {
      const raw = stripBlankTail(m[0]);
      return {
        type: 'html',
        block: true,
        raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        text: raw,
      };
    }
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (m) {
      if (!R.startAngleBracket.test(m[2]) && findParen(m[2], '()') !== -1) {
        return undefined;
      }
      const tag = normLabel(m[1]);
      const href = m[2]
        ? m[2].replace(R.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1')
        : '';
      const title = m[3]
        ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1')
        : m[3];
      return { type: 'def', tag, raw: trimEndChars(m[0], '\n'), href, title };
    }
  }

  table(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !R.tableDelimiter.test(m[2])) return undefined;
    const headerCells = splitCells(m[1]);
    const aligns = m[2].replace(R.tableAlignChars, '').split('|');
    const bodyLines = m[3]?.trim()
      ? m[3].replace(R.tableRowBlankLine, '').split('\n')
      : [];
    const tableTok = {
      type: 'table',
      raw: trimEndChars(m[0], '\n'),
      header: [],
      align: [],
      rows: [],
    };
    if (headerCells.length === aligns.length) {
      for (const cell of aligns) {
        if (R.tableAlignRight.test(cell)) tableTok.align.push('right');
        else if (R.tableAlignCenter.test(cell)) tableTok.align.push('center');
        else if (R.tableAlignLeft.test(cell)) tableTok.align.push('left');
        else tableTok.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        tableTok.header.push({
          text: headerCells[i],
          tokens: this.lexer.inline(headerCells[i]),
          header: true,
          align: tableTok.align[i],
        });
      }
      for (const line of bodyLines) {
        tableTok.rows.push(
          splitCells(line, tableTok.header.length).map((cell, i) => ({
            text: cell,
            tokens: this.lexer.inline(cell),
            header: false,
            align: tableTok.align[i],
          })),
        );
      }
      return tableTok;
    }
    return undefined;
  }

  lheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return {
        type: 'heading',
        raw: trimEndChars(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  paragraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (m) {
      const text =
        m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return {
        type: 'paragraph',
        raw: m[0],
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (m) {
      return {
        type: 'text',
        raw: m[0],
        text: m[0],
        tokens: this.lexer.inline(m[0]),
      };
    }
  }
}

// ---- Inline tokenizer methods (added to Tokenizer) ----

/**
 * Build a link/image token from a matched label, parsing the label text
 * for inline tokens. A link whose text itself contains a link is
 * dropped (the inner link wins); images are exempt from that rule.
 */
function buildLink(match, def, raw, lexer) {
  const href = def.href;
  const title = def.title || null;
  const text = match[1].replace(R.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = lexer.state.inLink;
  const savedEmitted = lexer.state.linkEmitted;
  const savedRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const innerEmitted = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (innerEmitted) {
      lexer.state.inRawBlock = savedRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

Object.assign(Tokenizer.prototype, {
  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  },

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (m) {
      if (!this.lexer.state.inLink && R.startATag.test(m[0])) {
        this.lexer.state.inLink = true;
      } else if (this.lexer.state.inLink && R.endATag.test(m[0])) {
        this.lexer.state.inLink = false;
      }
      if (!this.lexer.state.inRawBlock && R.startPreScriptTag.test(m[0])) {
        this.lexer.state.inRawBlock = true;
      } else if (
        this.lexer.state.inRawBlock &&
        R.endPreScriptTag.test(m[0])
      ) {
        this.lexer.state.inRawBlock = false;
      }
      return {
        type: 'html',
        raw: m[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        block: false,
        text: m[0],
      };
    }
  },

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return undefined;
    const m = INLINE.link.exec(src);
    if (!m) return undefined;
    const offset = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasTag(src, m[1], offset)) return undefined;
    const hrefPart = m[2].trim();
    if (R.startAngleBracket.test(hrefPart)) {
      if (!R.endAngleBracket.test(hrefPart)) return undefined;
      const stripped = trimEndChars(hrefPart.slice(0, -1), '\\');
      if ((hrefPart.length - stripped.length) % 2 === 0) return undefined;
    } else {
      const paren = findParen(m[2], '()');
      if (paren === -2) return undefined;
      if (paren > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + paren;
        m[2] = m[2].substring(0, paren);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const rawStripped = trimEndChars(m[0].slice(0, -1), '\\');
    if ((m[0].length - rawStripped.length) % 2 === 0) return undefined;
    let href = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (R.startAngleBracket.test(href)) href = href.slice(1, -1);
    return buildLink(
      m,
      {
        href: href && href.replace(INLINE.anyPunctuation, '$1'),
        title: title && title.replace(INLINE.anyPunctuation, '$1'),
      },
      m[0],
      this.lexer,
    );
  },

  reflink(src, links) {
    const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (m) {
      const offset = m[0].charAt(0) === '!' ? 2 : 1;
      if (linkTextHasTag(src, m[1], offset)) return undefined;
      const def = links[normLabel(m[2] || m[1])];
      if (!def) {
        const ch = m[0].charAt(0);
        return { type: 'text', raw: ch, text: ch };
      }
      return buildLink(m, def, m[0], this.lexer);
    }
  },

  emStrong(src, masked, prev = '') {
    const m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
    const delim = m[0][0];
    const sameAsPrev = prev === delim;
    const offset = masked.length - src.length;
    let runStart = offset;
    for (; runStart > 0 && masked[runStart - 1] === delim;) runStart--;
    const beforeRun =
      [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsPunct =
      beforeRun === '*' ||
      beforeRun === '_' ||
      !!INLINE.punctuation.exec(beforeRun);
    let prevChar = prev;
    if (runStart < offset) prevChar = beforeRun;
    const prevIsPunct = runStart < offset
      ? beforeIsPunct
      : !!INLINE.punctuation.exec(prevChar);
    if (m[4] && prevChar.match(R.unicodeAlphaNumeric)) return undefined;
    const afterPunct = m[1] || m[3] || '';
    if (!afterPunct || !prevChar || prevIsPunct) {
      const openLen = [...m[0]].length - 1;
      let openLeft = openLen;
      let skipped = 0;
      const total = offset - runStart + openLen;
      const canOpen =
        !!beforeRun.trim() && (!!afterPunct || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return undefined;
      const closerRe =
        delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = this.lexer.delimEnd(masked, delim);
      const needAt = masked.length - src.length + openLen;
      if (lastCloser < needAt) return undefined;
      const rest = masked.slice(-src.length + openLen);
      const limit = lastCloser - needAt;
      let s;
      for (
        closerRe.lastIndex = 0;
        (s = closerRe.exec(rest)) !== null && !(s.index > limit);
      ) {
        const run = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
        if (!run) continue;
        let runLen = [...run].length;
        if (s[3] || s[4]) {
          openLeft += runLen;
          continue;
        } else if (s[5] || s[6] || canOpen) {
          if (sameAsPrev && (s[5] || s[6])) break;
          if (total % 3 && !((total + runLen) % 3)) {
            skipped += runLen;
            continue;
          }
        }
        openLeft -= runLen;
        if (openLeft > 0) continue;
        runLen = Math.min(runLen, runLen + openLeft + skipped);
        const firstLen = [...s[0]][0].length;
        const raw = src.slice(0, openLen + s.index + firstLen + runLen);
        if (Math.min(openLen, runLen) % 2) {
          const inner = raw.slice(1, -1);
          return {
            type: 'em',
            raw,
            text: inner,
            tokens: this.lexer.inlineTokens(inner),
          };
        }
        const inner = raw.slice(2, -2);
        return {
          type: 'strong',
          raw,
          text: inner,
          tokens: this.lexer.inlineTokens(inner),
        };
      }
    }
    return undefined;
  },

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (m) {
      let text = m[2].replace(R.newLineCharGlobal, ' ');
      const hasNonSpace = R.nonSpaceChar.test(text);
      const padded =
        R.startingSpaceChar.test(text) && R.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: m[0], text };
    }
  },

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  },

  del(src, masked, prev = '') {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return undefined;
    if (!(m[1] || '') || !prev || INLINE.punctuation.exec(prev)) {
      const openLen = [...m[0]].length - 1;
      let left = openLen;
      const closerRe = INLINE.delRDelim;
      const lastCloser = this.lexer.delEnd(masked);
      const needAt = masked.length - src.length + openLen;
      if (lastCloser < needAt) return undefined;
      const rest = masked.slice(-src.length + openLen);
      const limit = lastCloser - needAt;
      let s;
      for (
        closerRe.lastIndex = 0;
        (s = closerRe.exec(rest)) !== null && !(s.index > limit);
      ) {
        const run = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
        if (!run) continue;
        let runLen = [...run].length;
        if (runLen !== openLen) continue;
        if (s[3] || s[4]) {
          left += runLen;
          continue;
        }
        left -= runLen;
        if (left > 0) continue;
        runLen = Math.min(runLen, runLen + left);
        const firstLen = [...s[0]][0].length;
        const raw = src.slice(0, openLen + s.index + firstLen + runLen);
        const inner = raw.slice(openLen, -openLen);
        return {
          type: 'del',
          raw,
          text: inner,
          tokens: this.lexer.inlineTokens(inner),
        };
      }
    }
    return undefined;
  },

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[1];
        href = 'mailto:' + text;
      } else {
        text = m[1];
        href = text;
      }
      return {
        type: 'link',
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  },

  url(src) {
    const m = INLINE.url.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[0];
        href = 'mailto:' + text;
      } else {
        let cur = m[0];
        do {
          const prev = cur;
          cur = INLINE.backpedal.exec(cur)?.[0] ?? '';
          if (prev === cur) break;
        } while (true);
        m[0] = cur;
        text = cur;
        href = m[1] === 'www.' ? 'http://' + cur : cur;
      }
      return {
        type: 'link',
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  },

  inlineText(src) {
    const m = INLINE.text.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return {
        type: 'text',
        raw: m[0],
        text: inRaw ? m[0] : unesc(m[0]),
        escaped: inRaw,
      };
    }
  },
});

// ---- Lexer ----
// Block-lexes a document, then fills in the inline tokens that block
// tokenizers queued (inline parsing is deferred so link definitions,
// which may appear after their use, are all known first).

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
    this.delimStack = [];
    this.tokenizer = new Tokenizer(this);
  }

  lex(src) {
    src = src.replace(R.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const queued = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(queued.src, queued.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens = [], inBlockquote = false) {
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      let tok;
      if ((tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.code(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.fences(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.heading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.hr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.blockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.list(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.html(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.def(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = last.text;
        } else {
          if (!this.tokens.links[tok.tag]) {
            this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          }
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.table(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.lheading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.tokenizer.paragraph(src))) {
        const last = tokens.at(-1);
        if (inBlockquote && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = last.text;
        } else {
          tokens.push(tok);
        }
        inBlockquote = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }
    this.state.top = true;
    return tokens;
  }

  /** Queue an inline parse; filled in once the block pass is done. */
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  /** True when the text contains a link (inline or reference) to parse. */
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      if (
        !(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && this.linkInText(s.slice(1, r - 1)))
      ) {
        return true;
      }
    }
    return false;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      const masked =
        src.includes('*') || src.includes('_') || src.includes('~')
          ? this.mask(src)
          : src;
      this.delimStack.push(scanDelimEnds(masked));
      try {
        return this.inlineLoop(src, masked, tokens);
      } finally {
        this.delimStack.pop();
      }
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineLoop(src, masked, tokens) {
    let merged = false;
    let prev = '';
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      if (!merged) prev = '';
      merged = false;
      let tok;
      if ((tok = this.tokenizer.escape(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.tag(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.link(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.reflink(src, this.tokens.links))) {
        src = src.substring(tok.raw.length);
        const last = tokens.at(-1);
        if (tok.type === 'text' && last?.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.emStrong(src, masked, prev))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.codespan(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.br(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.del(src, masked, prev))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.autolink(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!this.state.inLink && (tok = this.tokenizer.url(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.inlineText(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prev = tok.raw.slice(-1);
        merged = true;
        const last = tokens.at(-1);
        if (last?.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }
    return tokens;
  }

  /**
   * Mask an inline source for the emphasis scan: reference links and
   * code spans become inert runs of `a`, escaped punctuation becomes
   * `+`, so delimiters inside them can never close an emphasis span.
   * The masking is length-preserving, so indices still line up.
   */
  mask(src) {
    let out = src;
    if (this.tokens.links && src.includes('[')) {
      const search = INLINE.reflinkSearch;
      const fix = (match) => {
        const open = match.lastIndexOf('[');
        if (
          !Object.hasOwn(this.tokens.links, normLabel(match.slice(open + 1, -1)))
        ) {
          return match;
        }
        if (open > 1 && match.charAt(0) !== '!') {
          const inner = match.slice(1, open - 1);
          if (this.linkInText(inner)) {
            return (
              '[' +
              inner.replace(search, fix) +
              '][' +
              'a'.repeat(match.length - open - 2) +
              ']'
            );
          }
        }
        return '[' + 'a'.repeat(match.length - 2) + ']';
      };
      out = out.replace(search, fix);
    }
    out = out.replace(
      INLINE.anyPunctuationOutsideCode,
      (match, ticks, punct) =>
        punct
          ? '+'.repeat(match.length)
          : ticks
            ? ticks +
              match.slice(ticks.length, -ticks.length).replace(/`/g, '+') +
              ticks
            : match,
    );
    out = out.replace(INLINE.blockSkip, (match, _tickRun, precode) => {
      const keep = precode ? precode.length : 0;
      return match.slice(0, keep) + '[' + 'a'.repeat(match.length - keep - 2) + ']';
    });
    return out;
  }

  /** Last index a `*`/`_` closer may start at in `masked`. */
  delimEnd(masked, ch) {
    const top = this.delimStack.at(-1);
    if (top && top.masked === masked) return top.emEnds[ch];
    return scanDelimEnds(masked).emEnds[ch];
  }

  /** Last index a `~~` closer may start at in `masked`. */
  delEnd(masked) {
    const top = this.delimStack.at(-1);
    if (top && top.masked === masked) return top.delEnd;
    return scanDelimEnds(masked).delEnd;
  }

  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte);
  }
}

// ---- Renderer ----

class Renderer {
  constructor() {
    this.parser = null;
  }

  space() {
    return '';
  }

  code(tok) {
    const lang = (tok.lang || '').match(R.notSpaceStart)?.[0];
    const body = tok.text ? tok.text.replace(R.endingNewline, '') + '\n' : '';
    const inner = tok.escaped ? body : esc(body, true);
    return lang
      ? `<pre><code class="language-${esc(lang)}">${inner}</code></pre>\n`
      : `<pre><code>${inner}</code></pre>\n`;
  }

  blockquote(tok) {
    return `<blockquote>\n${this.parser.parse(tok.tokens)}</blockquote>\n`;
  }

  html(tok) {
    return tok.text;
  }

  def() {
    return '';
  }

  heading(tok) {
    return `<h${tok.depth}>${this.parser.parseInline(tok.tokens)}</h${tok.depth}>\n`;
  }

  hr() {
    return '<hr>\n';
  }

  list(tok) {
    let items = '';
    for (const item of tok.items) items += this.listitem(item);
    const tag = tok.ordered ? 'ol' : 'ul';
    const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
    return `<${tag}${start}>\n${items}</${tag}>\n`;
  }

  listitem(tok) {
    return `<li>${this.parser.parse(tok.tokens)}</li>\n`;
  }

  checkbox(tok) {
    return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
  }

  paragraph(tok) {
    return `<p>${this.parser.parseInline(tok.tokens)}</p>\n`;
  }

  table(tok) {
    let headCells = '';
    for (const cell of tok.header) headCells += this.tablecell(cell);
    let head = this.tablerow({ text: headCells });
    let body = '';
    for (const row of tok.rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
  }

  tablerow(tok) {
    return `<tr>\n${tok.text}</tr>\n`;
  }

  tablecell(tok) {
    const inner = this.parser.parseInline(tok.tokens);
    const tag = tok.header ? 'th' : 'td';
    return (tok.align ? `<${tag} align="${tok.align}">` : `<${tag}>`) +
      inner +
      `</${tag}>\n`;
  }

  strong(tok) {
    return `<strong>${this.parser.parseInline(tok.tokens)}</strong>`;
  }

  em(tok) {
    return `<em>${this.parser.parseInline(tok.tokens)}</em>`;
  }

  codespan(tok) {
    return `<code>${esc(tok.text, true)}</code>`;
  }

  br() {
    return '<br>';
  }

  del(tok) {
    return `<del>${this.parser.parseInline(tok.tokens)}</del>`;
  }

  link(tok) {
    const inner = tok.autolink
      ? esc(tok.text, true)
      : this.parser.parseInline(tok.tokens);
    const href = cleanUrl(tok.href);
    if (href === null) return inner;
    const safeHref = esc(href, tok.autolink);
    let out = `<a href="${safeHref}"`;
    if (tok.title) out += ` title="${esc(tok.title)}"`;
    return out + `>${inner}</a>`;
  }

  image(tok) {
    let alt = tok.text;
    if (tok.tokens) alt = this.parser.parseInline(tok.tokens, this.parser.textRenderer);
    const href = cleanUrl(tok.href);
    if (href === null) return esc(alt);
    let out = `<img src="${esc(href)}" alt="${esc(alt)}"`;
    if (tok.title) out += ` title="${esc(tok.title)}"`;
    return out + '>';
  }

  text(tok) {
    if ('tokens' in tok && tok.tokens) {
      return this.parser.parseInline(tok.tokens);
    }
    if ('escaped' in tok && tok.escaped) return tok.text;
    return esc(tok.text);
  }
}

// Plain-text renderer: image alt text, emphasis content without tags.
class TextRenderer {
  constructor() {
    this.parser = null;
  }

  strong(tok) {
    return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text;
  }

  em(tok) {
    return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text;
  }

  codespan(tok) {
    return tok.text;
  }

  del(tok) {
    return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text;
  }

  html(tok) {
    return tok.text;
  }

  text(tok) {
    return tok.text;
  }

  link(tok) {
    return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text;
  }

  image(tok) {
    return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text;
  }

  br() {
    return '';
  }

  checkbox(tok) {
    return tok.raw;
  }
}

// ---- Parser ----

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    this.renderer.parser = this;
    let out = '';
    for (const tok of tokens) {
      switch (tok.type) {
        case 'space': out += this.renderer.space(tok); break;
        case 'hr': out += this.renderer.hr(tok); break;
        case 'heading': out += this.renderer.heading(tok); break;
        case 'code': out += this.renderer.code(tok); break;
        case 'table': out += this.renderer.table(tok); break;
        case 'blockquote': out += this.renderer.blockquote(tok); break;
        case 'list': out += this.renderer.list(tok); break;
        case 'checkbox': out += this.renderer.checkbox(tok); break;
        case 'html': out += this.renderer.html(tok); break;
        case 'def': out += this.renderer.def(tok); break;
        case 'paragraph': out += this.renderer.paragraph(tok); break;
        case 'text': out += this.renderer.text(tok); break;
        default:
          throw new Error(`Token with "${tok.type}" type was not found.`);
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    this.renderer.parser = this;
    let out = '';
    for (const tok of tokens) {
      switch (tok.type) {
        case 'escape': out += renderer.text(tok); break;
        case 'html': out += renderer.html(tok); break;
        case 'link': out += renderer.link(tok); break;
        case 'image': out += renderer.image(tok); break;
        case 'checkbox': out += renderer.checkbox(tok); break;
        case 'strong': out += renderer.strong(tok); break;
        case 'em': out += renderer.em(tok); break;
        case 'codespan': out += renderer.codespan(tok); break;
        case 'br': out += renderer.br(tok); break;
        case 'del': out += renderer.del(tok); break;
        case 'text': out += renderer.text(tok); break;
        default:
          throw new Error(`Token with "${tok.type}" type was not found.`);
      }
    }
    return out;
  }
}

/** Render `markdown` to HTML, exactly as marked 18.1.3 does by default. */
export function parse(markdown) {
  const tokens = new Lexer().lex(markdown);
  return new Parser().parse(tokens);
}
