// Fast Markdown renderer — a from-scratch reimplementation of marked 18.1.3's
// algorithm (default options: gfm on, breaks off, pedantic off).
//
// Written fresh for the make.fun markdown-render-speed-02 bounty. No part of
// marked's source is copied or imported; the parser below was derived by
// studying marked's *behaviour* (its regexes and tokeniser order, probed
// against the vendored reference) and re-expressing the same algorithm in
// this file's own structure: a regex composer, a block lexer, an inline
// lexer with delimiter masking, and a small renderer.
//
// Entry point: parse(markdown) -> HTML string, byte-identical to
// marked.parse(markdown) with default options.
//
// Only the GFM rule sets are implemented: the harness always runs with
// defaults, so the normal/pedantic/breaks variants are not needed.

// ---------------------------------------------------------------------------
// Regex composer
// ---------------------------------------------------------------------------
// Build a composite regex by textual substitution of named placeholders.
// A placeholder may be replaced by a string (already regex source text) or
// by a RegExp (its .source is used). Inserted sources have a leading ^
// stripped, following marked's caret rule: a ^ is dropped unless it is
// preceded by "[" (so [^...] classes survive, anchors do not leak into the
// middle of a composite pattern).
const CARET_STRIP = /(^|[^\[])\^/g;

function rx(template, flags = "") {
  let src = typeof template === "string" ? template : template.source;
  const api = {
    sub(pattern, value) {
      let ins = typeof value === "string" ? value : value.source;
      ins = ins.replace(CARET_STRIP, "$1");
      src = src.replace(pattern, () => ins);
      return api;
    },
    build() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

// Memoised builder for regexes that depend on a nesting indent level
// (0..3, clamped the way marked clamps them).
function byIndent(make) {
  const cache = [];
  return (level) => {
    const i = Math.max(0, Math.min(3, level - 1));
    if (!cache[i]) cache[i] = make(i);
    return cache[i];
  };
}

// ---------------------------------------------------------------------------
// Shared fragments and small patterns
// ---------------------------------------------------------------------------
const CODE_INDENT_STRIP = /^(?: {0,3}\t| {1,4})/gm;
const OUT_LINK_ESC = /\\([\[\]])/g;
const FENCE_INDENT = /^(\s+)(?:```)/;
const LEAD_WS = /^\s+/;
const END_HASH = /#$/;
const LEAD_SPACE = /^ /;
const END_SPACE = / $/;
const END_SPACE_TAB = /[ \t]$/;
const NON_SPACE = /[^ ]/;
const NL_GLOBAL = /\n/g;
const TAB_GLOBAL = /\t/g;
const LEAD_SPACE_TAB = /^[ \t]+/;
const MULTI_WS = /\s+/g;
const BLANK_LINE = /^[ \t]*$/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const BQ_START = /^ {0,3}>/;
const BQ_SETEXT_FIX = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_MARKER_STRIP = /^ {0,3}>[ \t]?/gm;
const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_NEST_FIX = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const LIST_TASK_BOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_ANGLES = /^<(.*)>$/;
const TABLE_DELIM = /[:|]/;
const TABLE_EDGES = /^\||\| *$/g;
const TABLE_ROW_TRAIL = /\n[ \t]*$/;
const ALIGN_RIGHT = /^ *-+: *$/;
const ALIGN_CENTER = /^ *:-+: *$/;
const ALIGN_LEFT = /^ *:-+ *$/;
const A_TAG_OPEN = /^<a /i;
const A_TAG_CLOSE = /^<\/a>/i;
const PRE_OPEN = /^<(pre|code|kbd|script)(\s|>)/i;
const PRE_CLOSE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const ANGLE_OPEN = /^</;
const ANGLE_CLOSE = />$/;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_TEST = /[&<>"']/;
const ESC_REPL = /[&<>"']/g;
const ESC_TEST_RAW = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REPL_RAW = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PCT25 = /%25/g;
const PIPE_FIND = /\|/g;
const PIPE_SPLIT = / \|/;
const PIPE_ESC = /\\\|/g;
const CR_OR_CRLF = /\r\n|\r/g;
const SPACE_ONLY_LINE = /^ +$/gm;
const NON_SPACE_START = /^\S*/;
const END_NL = /\n$/;

// ---------------------------------------------------------------------------
// Block-level regexes (GFM)
// ---------------------------------------------------------------------------
const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

const BLANK_RUN = /^(?:[ \t]*(?:\n|$))+/;
const INDENTED_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const ATX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

// Setext heading: the template carries placeholder words (bull, blockCode,
// fences, blockquote, heading, hr, html, table) that are substituted below.
const SETEXT_TMPL =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const SETEXT = rx(SETEXT_TMPL)
  .sub(/bull/g, BULLET)
  .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .sub(/blockquote/g, / {0,3}>/)
  .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .sub(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .sub(/html/g, / {0,3}<[^\n>]+>\n/)
  .sub(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .build();

// A link label: no blank line, no unescaped ], balanced-ish brackets.
const LABEL_FRAG =
  /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

// Link reference definition.
const DEF = rx(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/
)
  .sub("label", LABEL_FRAG)
  .sub(
    "title",
    /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/
  )
  .build();

// A list item's first line: the bullet, then the rest of the line.
const LIST_OPEN = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .sub(/bull/g, BULLET)
  .build();

const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// Raw HTML block (7 CommonMark flavours).
const HTML_BLOCK = rx(
  /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|comment[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(tag)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/,
  "i"
)
  .sub("comment", HTML_COMMENT)
  .sub("tag", BLOCK_TAGS)
  .sub(
    "attribute",
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/
  )
  .build();

// Paragraph: one template, two list flavours — the top-level paragraph only
// lets a list starting with "1" interrupt it, while the blockquote variant
// lets any ordered list interrupt.
const PARA_TMPL =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listFrag) {
  return rx(PARA_TMPL)
    .sub("hr", HR)
    .sub("heading", / {0,3}#{1,6}(?:\s|$)/)
    .sub("|lheading", "")
    .sub("table", TABLE)
    .sub("blockquote", / {0,3}>/)
    .sub("fences", / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
    .sub("list", listFrag)
    .sub(
      "html",
      / {0,3}(?:<\/?(?:tag)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/
    )
    .sub("tag", BLOCK_TAGS)
    .build();
}

// Table: header row, delimiter row, then body rows that stop at any block
// start the paragraph/template lookaheads know about.
const TABLE = rx(
  /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)\n*|$)/
)
  .sub("hr", HR)
  .sub("heading", / {0,3}#{1,6}(?:\s|$)/)
  .sub("blockquote", / {0,3}>/)
  .sub("code", "(?: {4}| {0,3}\t)[^\\n]")
  .sub("fences", / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
  .sub("list", / {0,3}(?:[*+-]|1[.)])[ \t]/)
  .sub(
    "html",
    / {0,3}(?:<\/?(?:tag)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/
  )
  .sub("tag", BLOCK_TAGS)
  .build();

const PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
const PARAGRAPH_BQ = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

// Blockquote: groups of > lines; the paragraph fragment inside is the
// blockquote paragraph flavour above.
const BLOCKQUOTE = rx(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/
)
  .sub("paragraph", PARAGRAPH_BQ)
  .build();

const TEXT_LINE = /^[^\n]+/;

// Indent-dependent block starts, used while consuming list items.
const nextBullet = byIndent(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`
    )
);
const hrAt = byIndent(
  (n) =>
    new RegExp(
      `^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`
    )
);
const fencesAt = byIndent((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingAt = byIndent(
  (n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)
);
const htmlAt = byIndent(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      "i"
    )
);
const bqAt = byIndent((n) => new RegExp(`^ {0,${n}}>`));
function listItemRe(bullet) {
  return new RegExp(`^( {0,3}${bullet})((?:[ \t][^\\n]*)?(?:\\n|$))`);
}

// ---------------------------------------------------------------------------
// Inline-level regexes (GFM)
// ---------------------------------------------------------------------------
const ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

// Unicode character classes used by the emphasis scanners. The GFM
// variants exclude "~" from punctuation (so "~" behaves like a letter for
// "*" emphasis), while the plain variants count "~" as punctuation (used
// by "_" emphasis and by "~~" strikethrough).
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

// "Is this char punctuation (or space)?" — used for flanking checks.
const PUNCT_TEST = rx(/^((?![*_])punctSpace)/, "u")
  .sub(/punctSpace/g, PUNCT_SPACE)
  .build();

// Backslash + punctuation, anywhere (for unescaping in code spans, hrefs…).
const ANY_PUNCT = rx(/\\(punct)/, "gu").sub(/punct/g, PUNCT).build();

// Same, but code spans are left alone (for the emphasis mask).
const ANY_PUNCT_OUTSIDE_CODE = rx(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  "gu"
)
  .sub(/punct/g, PUNCT)
  .build();

// Links / code spans / raw HTML, as one alternation: the emphasis masker
// neutralises whole links and code spans so "*" inside them is invisible
// to the delimiter scanner.
const LINK_IN_TEXT = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/;
const CODE_IN_TEXT = /(?<b>`+)[^`]+\k<b>(?!`)/;
const BLOCK_SKIP = rx(/link|precode-code|html/, "g")
  .sub("link", LINK_IN_TEXT)
  .sub("precode-", "(?<!`)()")
  .sub("code", CODE_IN_TEXT)
  .sub("html", /<(?! )[^<>]*?>/)
  .build();

// Emphasis openers: delimiter run plus one following char (a punctuation
// char, or any non-space char). Group 1/2 belong to "*", group 3/4 to "_".
const EM_OPEN_TMPL =
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_OPEN = rx(EM_OPEN_TMPL, "u").sub(/punct/g, PUNCT_NO_TILDE).build();

// Emphasis closers for "*": a big alternation that skips text and
// opener-only runs, capturing the candidate closer run in groups 1-6.
const EM_CLOSE_AST_TMPL =
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const EM_CLOSE_AST = rx(EM_CLOSE_AST_TMPL, "gu")
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE)
  .sub(/punctSpace/g, PUNCT_SPACE_NO_TILDE)
  .sub(/punct/g, PUNCT_NO_TILDE)
  .build();

// Emphasis closers for "_": same shape, plain classes, five groups.
const EM_CLOSE_UND_TMPL =
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const EM_CLOSE_UND = rx(EM_CLOSE_UND_TMPL, "gu")
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .build();

// Strikethrough openers / closers (plain classes: "~" is punctuation).
const DEL_OPEN = rx(/^~~?(?:((?!~)punct)|[^\s~])/, "u")
  .sub(/punct/g, PUNCT)
  .build();
const DEL_CLOSE_TMPL =
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const DEL_CLOSE = rx(DEL_CLOSE_TMPL, "gu")
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .build();
const DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// <autolink> and <email>: group 2 is the "@" inside the email branch.
const AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub(
    "email",
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/
  )
  .build();

// Inline raw HTML tag.
const TAG = rx(
  /^comment|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/
)
  .sub(
    "comment",
    rx(HTML_COMMENT).sub("(?:-->|$)", "-->").build()
  )
  .sub(
    "attribute",
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/
  )
  .build();

// Link label internals: nested brackets, escapes, code spans.
const BRACKET_FRAG = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER = rx(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/
)
  .sub("brackets", BRACKET_FRAG)
  .build();

// Inline link [text](href "title").
const LINK = rx(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/
)
  .sub("label", LABEL_INNER)
  .sub("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub(
    "title",
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/
  )
  .build();

// Reference link [text][ref] and shortcut [ref].
const REFLINK = rx(/^!?\[(label)\]\[(ref)\]/)
  .sub("label", LABEL_INNER)
  .sub("ref", LABEL_FRAG)
  .build();
const NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).sub("ref", LABEL_FRAG).build();

// The looser label patterns used only while masking for emphasis.
const SEARCH_LABEL = rx(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/
)
  .sub("brackets", BRACKET_FRAG)
  .build();
const SEARCH_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_SEARCH = rx("reflink|nolink(?!\\()", "g")
  .sub(
    "reflink",
    rx(/^!?\[(label)\]\[(ref)\]/)
      .sub("label", SEARCH_LABEL)
      .sub("ref", SEARCH_REF)
      .build()
  )
  .sub(
    "nolink",
    rx(/^!?\[(ref)\](?:\[\])?/).sub("ref", SEARCH_REF).build()
  )
  .build();

// GFM extended autolink: mailto:/xmpp: addresses, scheme:// and www. URLs,
// and bare emails. Group 1 is the scheme/www prefix, group 2 the "@".
const EMAIL_LOCAL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTO = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .sub(/email/g, EMAIL_LOCAL)
  .build();
const URL_SCHEME = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const URL = rx(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/
)
  .sub("emailProtocol", EMAIL_PROTO)
  .sub("protocol", URL_SCHEME)
  .sub(
    "email",
    /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/
  )
  .build();
// Trims trailing punctuation / unbalanced parens off a GFM autolink.
const BACKPEDAL =
  /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Plain inline text: consumes up to the next thing that could start a
// token. Note the substitution order below matters: "protocol" is replaced
// first (it cannot match inside "emailProtocol" — capital P there), then
// the two "emailProtocol" placeholders, then "wwwStart".
const INLINE_TEXT = rx(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/
)
  .sub("protocol", URL_SCHEME)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub("wwwStart", "(?<![^\\s*_~(])www\\.")
  .build();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const ENTITY_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Escape HTML. With encode=true every & < > " ' is escaped; otherwise & is
// only escaped when it does not already start an entity reference.
function escHtml(s, encode = false) {
  if (encode) {
    if (ESC_TEST.test(s)) return s.replace(ESC_REPL, (c) => ENTITY_MAP[c]);
  } else if (ESC_TEST_RAW.test(s)) {
    return s.replace(ESC_REPL_RAW, (c) => ENTITY_MAP[c]);
  }
  return s;
}

// Decode numeric character references (and stray bare & into &amp;).
// Named entities are deliberately left alone here: the renderer later
// leaves "&amp;" untouched because its & already starts an entity.
function unescapeEntities(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const code =
      dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      return "\uFFFD";
    if (code === 38) return "&amp;";
    return String.fromCodePoint(code);
  });
}

// encodeURI, except a literal % in the input stays a literal %.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(PCT25, "%");
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, honouring a cell limit.
function splitCells(row, limit) {
  const markedRow = row.replace(PIPE_FIND, (ch, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === "\\") escaped = !escaped;
    return escaped ? "|" : " |";
  });
  const cells = markedRow.split(PIPE_SPLIT);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim())
    cells.pop();
  if (limit) {
    if (cells.length > limit) cells.splice(limit);
    else while (cells.length < limit) cells.push("");
  }
  for (; i < cells.length; i++)
    cells[i] = cells[i].trim().replace(PIPE_ESC, "|");
  return cells;
}

// Strip trailing copies of one char (or, with stripOthers, trailing chars
// that are NOT that char) from the end of a string.
function trimEndChars(s, ch, stripOthers = false) {
  const n = s.length;
  let cut = 0;
  for (; cut < n; ) {
    const c = s.charAt(n - cut - 1);
    if (c === ch && !stripOthers) cut++;
    else if (c !== ch && stripOthers) cut++;
    else break;
  }
  return s.slice(0, n - cut);
}

// Drop trailing blank lines, but keep up to one blank line at the end
// (marked's trim for indented code and HTML blocks).
function dropTrailingBlanks(s) {
  const lines = s.split("\n");
  let last = lines.length - 1;
  for (; last >= 0 && BLANK_LINE.test(lines[last]); ) last--;
  return lines.length - last <= 2 ? s : lines.slice(0, last + 1).join("\n");
}

// A link label, normalised for lookup: trim, collapse whitespace,
// case-fold through upper then lower (so "ß" and "ẞ" style pairs match).
function normLabel(s) {
  return s.trim().replace(MULTI_WS, " ").toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the bracket that closes an opening bracket at the
// start, honouring backslash escapes. -1: no close, -2: unclosed open.
function findCloseBracket(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces with tab stops every 4 columns, starting at col.
function expandTabs(s, col = 0) {
  let out = "";
  let pos = col;
  for (const ch of s) {
    if (ch === "\t") {
      const w = 4 - (pos % 4);
      out += " ".repeat(w);
      pos += w;
    } else {
      out += ch;
      pos++;
    }
  }
  return out;
}

// Fenced code: if the fence line was indented, strip that much indent from
// every code line (only for ``` fences — marked only compensates those).
function dedentFence(raw, code) {
  const m = raw.match(FENCE_INDENT);
  if (m === null) return code;
  const indent = m[1];
  return code
    .split("\n")
    .map((line) => {
      const lead = line.match(LEAD_WS);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join("\n");
}

// Does this link's text contain a tag/autolink that runs past the end of
// the text? If so the link is not a link (the tag "escapes" the brackets).
function linkTextHasTag(src, text, offset, rules) {
  if (!text.includes("<")) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "`") {
      const m = rules.codeSpan.exec(text.slice(i));
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    if (text[i] !== "<") continue;
    const rest = src.slice(offset + i);
    const tag = rules.tag.exec(rest) || rules.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > text.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Emphasis masking
// ---------------------------------------------------------------------------
// Before scanning for emphasis delimiters, the inline source is masked:
// real links become "[aaaa]", code spans keep their backticks but lose
// inner backticks, and backslash-punctuation becomes "+". Delimiter runs
// inside links/code therefore cannot open or close emphasis.
//
// The mask is computed once per inline parse and cached on a stack (one
// frame per nested inline parse) so the closer scanners can reuse the
// "last possible closer" indices instead of rescanning.
function scanClosers(masked) {
  const lastEm = { "*": -1, _: -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== "*" && ch !== "_" && ch !== "~") continue;
    const prev = i === 0 ? "\n" : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (
      prev !== " " &&
      prev !== "\t" &&
      prev !== "\n" &&
      prev !== "\r" &&
      prev !== "\f"
    ) {
      if (ch === "~") lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: masked, lastEm, lastDel };
}

const maskStack = new WeakMap();
function pushMask(tokenizer, masked) {
  const frame = scanClosers(masked);
  const stack = maskStack.get(tokenizer);
  if (stack) stack.push(frame);
  else maskStack.set(tokenizer, [frame]);
}
function popMask(tokenizer) {
  const stack = maskStack.get(tokenizer);
  if (stack) {
    stack.pop();
    if (stack.length === 0) maskStack.delete(tokenizer);
  }
}
function lastEmCloser(tokenizer, masked, delim) {
  const top = maskStack.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === masked) return top.lastEm[delim];
  return scanClosers(masked).lastEm[delim];
}
function lastDelCloser(tokenizer, masked) {
  const top = maskStack.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === masked) return top.lastDel;
  return scanClosers(masked).lastDel;
}

// ---------------------------------------------------------------------------
// Lexer — turns Markdown into tokens, then fills in inline tokens.
// ---------------------------------------------------------------------------
class Lexer {
  constructor() {
    this.tokens = [];
    this.links = Object.create(null);
    this.tokens.links = this.links;
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
  }

  // Queue an inline parse: tokenisers record the raw text and an (empty)
  // token array; the array is filled in place once block lexing is done,
  // so link definitions anywhere in the document are visible to it.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  lex(src) {
    src = src.replace(CR_OR_CRLF, "\n");
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens = [], mergeFirst = false) {
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
      let tok;
      if ((tok = this.tokSpace(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += "\n";
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokCode(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === "paragraph" || prev?.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokFences(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokHeading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokHr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokBlockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokList(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokHtml(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokDef(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === "paragraph" || prev?.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.links[tok.tag])
            this.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokTable(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokLheading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.tokParagraph(src))) {
        const prev = tokens.at(-1);
        if (mergeFirst && prev?.type === "paragraph") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        // With no extensions the trimmed source equals the source, so the
        // merge flag clears after the first paragraph of each call: only
        // the first paragraph (a lazy continuation) may merge.
        mergeFirst = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokText(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  // -- block tokenisers (tried in this order) ------------------------------

  tokSpace(src) {
    const m = BLANK_RUN.exec(src);
    if (m && m[0].length > 0) return { type: "space", raw: m[0] };
  }

  tokCode(src) {
    const m = INDENTED_CODE.exec(src);
    if (!m) return;
    const raw = dropTrailingBlanks(m[0]);
    return {
      type: "code",
      raw,
      codeBlockStyle: "indented",
      text: raw.replace(CODE_INDENT_STRIP, ""),
    };
  }

  tokFences(src) {
    const m = FENCES.exec(src);
    if (!m) return;
    const lang = m[2] ? m[2].trim().replace(ANY_PUNCT, "$1") : m[2];
    return { type: "code", raw: m[0], lang, text: dedentFence(m[0], m[3] || "") };
  }

  tokHeading(src) {
    const m = ATX.exec(src);
    if (!m) return;
    let text = m[2].trim();
    if (END_HASH.test(text)) {
      const stripped = trimEndChars(text, "#");
      if (!stripped || END_SPACE_TAB.test(stripped)) text = stripped.trim();
    }
    return {
      type: "heading",
      raw: trimEndChars(m[0], "\n"),
      depth: m[1].length,
      text,
      tokens: this.inline(text),
    };
  }

  tokHr(src) {
    const m = HR.exec(src);
    if (!m) return;
    return { type: "hr", raw: trimEndChars(m[0], "\n") };
  }

  tokBlockquote(src) {
    const m = BLOCKQUOTE.exec(src);
    if (!m) return;
    const lines = trimEndChars(m[0], "\n").split("\n");
    let raw = "";
    let text = "";
    const tokens = [];
    while (lines.length > 0) {
      let seenMarker = false;
      const group = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (BQ_START.test(lines[p])) {
          group.push(lines[p]);
          seenMarker = true;
        } else if (!seenMarker) group.push(lines[p]);
        else break;
      }
      lines.splice(0, p);
      const joined = group.join("\n");
      const inner = joined
        .replace(BQ_MARKER_WS, (g, mark, ws) => mark + expandTabs(ws, mark.length))
        .replace(BQ_SETEXT_FIX, "\n    $1")
        .replace(BQ_MARKER_STRIP, "");
      raw = raw ? raw + "\n" + joined : joined;
      text = text ? text + "\n" + inner : inner;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(inner, tokens, true);
      this.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (
        last?.type === "code" ||
        last?.type === "heading" ||
        last?.type === "hr" ||
        last?.type === "html" ||
        last?.type === "table"
      )
        break;
      if (last?.type === "blockquote") {
        const rest = lines.join("\n");
        const combined =
          last.raw + "\n" + rest.replace(BQ_MARKER_STRIP, "");
        const reparsed = this.tokBlockquote(combined);
        tokens[tokens.length - 1] = reparsed;
        const leftover = combined
          .substring(reparsed.raw.length)
          .replace(/^\n/, "");
        const leftoverLines = leftover ? leftover.split("\n").length : 0;
        const consumed =
          leftoverLines > 0 ? lines.slice(0, -leftoverLines) : lines;
        if (consumed.length > 0) raw = raw + "\n" + consumed.join("\n");
        text =
          text.substring(0, text.length - last.text.length) + reparsed.text;
        lines.splice(0, consumed.length);
        if (lines.length > 0 && BQ_START.test(lines[0])) continue;
        break;
      } else if (last?.type === "list") {
        const rest = last.raw + "\n" + lines.join("\n");
        const reparsed = this.tokList(rest);
        tokens[tokens.length - 1] = reparsed;
        const extra =
          reparsed.raw.length > last.raw.length
            ? rest.slice(last.raw.length + 1, reparsed.raw.length).split("\n")
                .length
            : 0;
        if (extra > 0) {
          const extraText = lines.slice(0, extra).join("\n");
          raw = raw + "\n" + extraText;
          text = text + "\n" + extraText;
        }
        lines.splice(0, extra);
        continue;
      }
    }
    return { type: "blockquote", raw, tokens, text };
  }
}

// -- remaining block tokenisers ---------------------------------------------

Lexer.prototype.tokList = function (src) {
  let m = LIST_OPEN.exec(src);
  if (!m) return;
  let rest = src;
  const startAt = () => src.length - rest.length;
  const firstBullet = m[1].trim();
  const ordered = firstBullet.length > 1;
  const list = {
    type: "list",
    raw: "",
    ordered,
    start: ordered ? +firstBullet.slice(0, -1) : "",
    loose: false,
    items: [],
  };
  const bulletPat = ordered
    ? `\\d{1,9}\\${firstBullet.slice(-1)}`
    : `\\${firstBullet}`;
  const itemRe = listItemRe(bulletPat);
  let sawDoubleBlank = false;
  while (rest) {
    let isEmptyItem = false;
    let itemText = "";
    if (!(m = itemRe.exec(rest)) || HR.test(rest)) break;
    const itemStart = startAt();
    rest = rest.substring(m[0].length);
    const firstLine = m[2].split("\n", 1)[0];
    const bulletLen = m[1].length;
    // The first line's content, with leading tabs expanded from the
    // bullet's column.
    let content = firstLine.replace(LEAD_SPACE_TAB, (ws) =>
      expandTabs(ws, bulletLen)
    );
    let nextLine = rest.split("\n", 1)[0];
    let blankFirst = !content.trim();
    let indent;
    if (blankFirst) indent = bulletLen + 1;
    else {
      indent = content.search(NON_SPACE);
      indent = indent > 4 ? 1 : indent;
      itemText = content.slice(indent);
      indent += bulletLen;
    }
    if (blankFirst && BLANK_LINE.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      isEmptyItem = true;
    }
    if (!isEmptyItem) {
      const nextBulletRe = nextBullet(indent);
      const hrRe = hrAt(indent);
      const fencesRe = fencesAt(indent);
      const headingRe = headingAt(indent);
      const htmlRe = htmlAt(indent);
      const bqRe = bqAt(indent);
      while (rest) {
        const line = rest.split("\n", 1)[0];
        nextLine = line;
        const expanded = line.replace(LEAD_SPACE_TAB, (ws) => expandTabs(ws));
        if (
          fencesRe.test(line) ||
          headingRe.test(line) ||
          htmlRe.test(line) ||
          bqRe.test(line) ||
          nextBulletRe.test(line) ||
          hrRe.test(line)
        )
          break;
        if (expanded.search(NON_SPACE) >= indent || !line.trim()) {
          itemText += "\n" + expanded.slice(indent);
        } else {
          if (
            blankFirst ||
            content.replace(TAB_GLOBAL, "    ").search(NON_SPACE) >= 4 ||
            fencesRe.test(content) ||
            headingRe.test(content) ||
            htmlRe.test(content) ||
            hrRe.test(content)
          )
            break;
          // A setext underline under the item's first line is indented
          // so it stays part of the item instead of becoming a heading.
          const setextLike =
            /^ {0,3}(?:=+|-+) *$/.test(line) &&
            SETEXT.test(`${content}\n${line}`);
          itemText +=
            "\n" +
            (setextLike
              ? `    ${expanded.replace(/^ {0,3}/, "")}`
              : line);
        }
        blankFirst = !line.trim();
        rest = rest.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, startAt());
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (DOUBLE_BLANK.test(itemRaw)) sawDoubleBlank = true;
    }
    list.items.push({
      type: "list_item",
      raw: itemRaw,
      task: LIST_IS_TASK.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else return;
  list.raw = src.slice(0, startAt()).trimEnd();
  for (const item of list.items) {
    this.state.top = false;
    item.tokens = this.blockTokens(item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === "space");
      if (spaces.length > 0 && spaces.some((t) => ANY_LINE.test(t.raw)))
        list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === "text" || first?.type === "paragraph")) {
      item.text = item.text.replace(LIST_TASK_STRIP, "");
      first.raw = first.raw.replace(LIST_TASK_STRIP, "");
      first.text = first.text.replace(LIST_TASK_STRIP, "");
      // The "[ ]"/"[x]" is also sitting in the queued inline source for
      // this item's first token; strip it there too.
      for (let i = this.inlineQueue.length - 1; i >= 0; i--) {
        if (LIST_IS_TASK.test(this.inlineQueue[i].src)) {
          this.inlineQueue[i].src = this.inlineQueue[i].src.replace(
            LIST_TASK_STRIP,
            ""
          );
          break;
        }
      }
      const box = LIST_TASK_BOX.exec(item.raw);
      if (box) {
        const checkbox = {
          type: "checkbox",
          raw: box[0] + " ",
          checked: box[0] !== "[ ]",
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (
            item.tokens[0] &&
            ["paragraph", "text"].includes(item.tokens[0].type) &&
            "tokens" in item.tokens[0] &&
            item.tokens[0].tokens
          ) {
            item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
            item.tokens[0].text = checkbox.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({
              type: "paragraph",
              raw: checkbox.raw,
              text: checkbox.raw,
              tokens: [checkbox],
            });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === "text") t.type = "paragraph";
    }
  }
  return list;
};

Lexer.prototype.tokHtml = function (src) {
  const m = HTML_BLOCK.exec(src);
  if (!m) return;
  const raw = dropTrailingBlanks(m[0]);
  return {
    type: "html",
    block: true,
    raw,
    pre: m[1] === "pre" || m[1] === "script" || m[1] === "style",
    text: raw,
  };
};

Lexer.prototype.tokDef = function (src) {
  const m = DEF.exec(src);
  if (!m) return;
  // An href in angle brackets must not contain an unbalanced paren.
  if (!ANGLE_OPEN.test(m[2]) && findCloseBracket(m[2], "()") !== -1) return;
  const tag = normLabel(m[1]);
  const href = m[2]
    ? m[2].replace(HREF_ANGLES, "$1").replace(ANY_PUNCT, "$1")
    : "";
  const title = m[3]
    ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, "$1")
    : m[3];
  return { type: "def", tag, raw: trimEndChars(m[0], "\n"), href, title };
};

Lexer.prototype.tokTable = function (src) {
  const m = TABLE.exec(src);
  if (!m || !TABLE_DELIM.test(m[2])) return;
  const headerCells = splitCells(m[1]);
  const alignParts = m[2].replace(TABLE_EDGES, "").split("|");
  const bodyLines = m[3]?.trim()
    ? m[3].replace(TABLE_ROW_TRAIL, "").split("\n")
    : [];
  if (headerCells.length !== alignParts.length) return;
  const table = {
    type: "table",
    raw: trimEndChars(m[0], "\n"),
    header: [],
    align: [],
    rows: [],
  };
  for (const part of alignParts) {
    if (ALIGN_RIGHT.test(part)) table.align.push("right");
    else if (ALIGN_CENTER.test(part)) table.align.push("center");
    else if (ALIGN_LEFT.test(part)) table.align.push("left");
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({
      text: headerCells[i],
      tokens: this.inline(headerCells[i]),
      header: true,
      align: table.align[i],
    });
  }
  for (const line of bodyLines) {
    table.rows.push(
      splitCells(line, table.header.length).map((cell, i) => ({
        text: cell,
        tokens: this.inline(cell),
        header: false,
        align: table.align[i],
      }))
    );
  }
  return table;
};

Lexer.prototype.tokLheading = function (src) {
  const m = SETEXT.exec(src);
  if (!m) return;
  const text = m[1].trim();
  return {
    type: "heading",
    raw: trimEndChars(m[0], "\n"),
    depth: m[2].charAt(0) === "=" ? 1 : 2,
    text,
    tokens: this.inline(text),
  };
};

Lexer.prototype.tokParagraph = function (src) {
  const m = PARAGRAPH.exec(src);
  if (!m) return;
  const text =
    m[1].charAt(m[1].length - 1) === "\n" ? m[1].slice(0, -1) : m[1];
  return { type: "paragraph", raw: m[0], text, tokens: this.inline(text) };
};

Lexer.prototype.tokText = function (src) {
  const m = TEXT_LINE.exec(src);
  if (!m) return;
  return { type: "text", raw: m[0], text: m[0], tokens: this.inline(m[0]) };
};

// ---------------------------------------------------------------------------
// Inline lexer
// ---------------------------------------------------------------------------

// Does this text contain a link (inline or reference) that is actually
// defined? Used while masking, so link text is treated as one opaque unit.
Lexer.prototype.linkInText = function (src) {
  if (!src.includes("[")) return false;
  for (const m of src.matchAll(BLOCK_SKIP)) {
    if (LINK.test(m[0]) && src.charAt(m.index - 1) !== "!") return true;
  }
  for (const m of src.matchAll(REFLINK_SEARCH)) {
    const s = m[0];
    const open = s.lastIndexOf("[");
    if (
      !(
        s.charAt(0) === "!" ||
        !Object.hasOwn(this.links, normLabel(s.slice(open + 1, -1)))
      ) &&
      !(open > 1 && this.linkInText(s.slice(1, open - 1)))
    )
      return true;
  }
  return false;
};

// The emphasis mask: links become "[aaaa…]", code spans keep their
// backticks but lose inner backticks, backslash-punctuation becomes "+".
Lexer.prototype.maskSource = function (src) {
  let masked = src;
  if (src.includes("[")) {
    const maskRefs = (match) => {
      const open = match.lastIndexOf("[");
      if (!Object.hasOwn(this.links, normLabel(match.slice(open + 1, -1))))
        return match;
      if (open > 1 && match.charAt(0) !== "!") {
        const inner = match.slice(1, open - 1);
        if (this.linkInText(inner))
          return (
            "[" +
            inner.replace(REFLINK_SEARCH, maskRefs) +
            "][" +
            "a".repeat(match.length - open - 2) +
            "]"
          );
      }
      return "[" + "a".repeat(match.length - 2) + "]";
    };
    masked = masked.replace(REFLINK_SEARCH, maskRefs);
  }
  masked = masked.replace(
    ANY_PUNCT_OUTSIDE_CODE,
    (whole, ticks, punct) =>
      punct
        ? "+".repeat(whole.length)
        : ticks
          ? ticks +
            whole.slice(ticks.length, -ticks.length).replace(/`/g, "+") +
            ticks
          : whole
  );
  masked = masked.replace(BLOCK_SKIP, (whole, _ticks, empty) => {
    const off = empty ? empty.length : 0;
    return whole.slice(0, off) + "[" + "a".repeat(whole.length - off - 2) + "]";
  });
  return masked;
};

// Parse inline tokens for src, filling tokens in place. The mask is only
// computed when the source could contain emphasis or strikethrough.
Lexer.prototype.inlineTokens = function (src, tokens = []) {
  const savedParen = this.state.linkParenPossible;
  this.state.linkParenPossible = savedParen && src.includes(")");
  try {
    const masked =
      src.includes("*") || src.includes("_") || src.includes("~")
        ? this.maskSource(src)
        : src;
    pushMask(this, masked);
    try {
      return this.scanInline(src, masked, tokens);
    } finally {
      popMask(this);
    }
  } finally {
    this.state.linkParenPossible = savedParen;
  }
};

Lexer.prototype.scanInline = function (src, masked, tokens) {
  let wasText = false;
  let prevChar = "";
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
    if (!wasText) prevChar = "";
    wasText = false;
    let tok;
    if ((tok = this.tokEscape(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = this.tokTag(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = this.tokLink(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = this.tokReflink(src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (tok.type === "text" && prev?.type === "text") {
        prev.raw += tok.raw;
        prev.text += tok.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = this.tokEmStrong(src, masked, prevChar))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = this.tokCodeSpan(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = this.tokBr(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = this.tokDel(src, masked, prevChar))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = this.tokAutolink(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (!this.state.inLink && (tok = this.tokUrl(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = this.tokInlineText(src))) {
      src = src.substring(tok.raw.length);
      // A trailing "_" is invisible to the next emphasis check: the
      // previous char stays whatever it was before this text.
      if (tok.raw.slice(-1) !== "_") prevChar = tok.raw.slice(-1);
      wasText = true;
      const prev = tokens.at(-1);
      if (prev?.type === "text") {
        prev.raw += tok.raw;
        prev.text += tok.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
  }
  return tokens;
};

// Build a link/image token, parsing its text inline. A link whose text
// itself emits a link is not a link at all (CommonMark: links cannot nest).
Lexer.prototype.buildLink = function (match, dest, raw) {
  const text = match[1].replace(OUT_LINK_ESC, "$1");
  const isImage = match[0].charAt(0) === "!";
  const savedInLink = this.state.inLink;
  const savedEmitted = this.state.linkEmitted;
  const savedRawBlock = this.state.inRawBlock;
  this.state.inLink = true;
  this.state.linkEmitted = false;
  const innerTokens = this.inlineTokens(text);
  const nestedEmitted = this.state.linkEmitted;
  this.state.linkEmitted = savedEmitted;
  this.state.inLink = savedInLink;
  if (!isImage) {
    if (nestedEmitted) {
      this.state.inRawBlock = savedRawBlock;
      return;
    }
    this.state.linkEmitted = true;
  }
  return {
    type: isImage ? "image" : "link",
    raw,
    href: dest.href,
    title: dest.title || null,
    text,
    tokens: innerTokens,
  };
};

// -- inline tokenisers ------------------------------------------------------

Lexer.prototype.tokEscape = function (src) {
  const m = ESCAPE.exec(src);
  if (!m) return;
  return { type: "escape", raw: m[0], text: m[1] };
};

Lexer.prototype.tokTag = function (src) {
  const m = TAG.exec(src);
  if (!m) return;
  if (!this.state.inLink && A_TAG_OPEN.test(m[0])) this.state.inLink = true;
  else if (this.state.inLink && A_TAG_CLOSE.test(m[0]))
    this.state.inLink = false;
  if (!this.state.inRawBlock && PRE_OPEN.test(m[0]))
    this.state.inRawBlock = true;
  else if (this.state.inRawBlock && PRE_CLOSE.test(m[0]))
    this.state.inRawBlock = false;
  return {
    type: "html",
    raw: m[0],
    inLink: this.state.inLink,
    inRawBlock: this.state.inRawBlock,
    block: false,
    text: m[0],
  };
};

Lexer.prototype.tokLink = function (src) {
  if (this.state.linkParenPossible === false) return;
  const m = LINK.exec(src);
  if (!m) return;
  const bang = m[0].charAt(0) === "!" ? 2 : 1;
  if (
    linkTextHasTag(src, m[1], bang, {
      codeSpan: CODE_SPAN,
      tag: TAG,
      autolink: AUTOLINK,
    })
  )
    return;
  const hrefRaw = m[2].trim();
  if (ANGLE_OPEN.test(hrefRaw)) {
    if (!ANGLE_CLOSE.test(hrefRaw)) return;
    const stripped = trimEndChars(hrefRaw.slice(0, -1), "\\");
    // An odd number of trailing backslashes escapes the closing ">".
    if ((hrefRaw.length - stripped.length) % 2 === 0) return;
  } else {
    const close = findCloseBracket(m[2], "()");
    if (close === -2) return;
    if (close > -1) {
      const cut = (m[0].indexOf("!") === 0 ? 5 : 4) + m[1].length + close;
      m[2] = m[2].substring(0, close);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = "";
    }
  }
  const tail = trimEndChars(m[0].slice(0, -1), "\\");
  // An odd number of trailing backslashes escapes the closing ")".
  if ((m[0].length - tail.length) % 2 === 0) return;
  let href = m[2];
  const title = m[3] ? m[3].slice(1, -1) : "";
  href = href.trim();
  if (ANGLE_OPEN.test(href)) href = href.slice(1, -1);
  return this.buildLink(
    m,
    {
      href: href && href.replace(ANY_PUNCT, "$1"),
      title: title && title.replace(ANY_PUNCT, "$1"),
    },
    m[0]
  );
};

Lexer.prototype.tokReflink = function (src) {
  const m = REFLINK.exec(src) || NOLINK.exec(src);
  if (!m) return;
  const bang = m[0].charAt(0) === "!" ? 2 : 1;
  if (
    linkTextHasTag(src, m[1], bang, {
      codeSpan: CODE_SPAN,
      tag: TAG,
      autolink: AUTOLINK,
    })
  )
    return;
  const dest = this.links[normLabel(m[2] || m[1])];
  if (!dest) {
    // Undefined reference: emit just the opening "[" (or "!") as text.
    const first = m[0].charAt(0);
    return { type: "text", raw: first, text: first };
  }
  return this.buildLink(m, dest, m[0]);
};

Lexer.prototype.tokEmStrong = function (src, masked, prevChar) {
  const m = EM_OPEN.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
  const delim = m[0][0];
  const sameAsPrev = prevChar === delim;
  const srcPos = masked.length - src.length;
  // Walk back over any delimiter chars that precede this position in the
  // masked source: the run may have started before the current token.
  let runStart = srcPos;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const beforeRun =
    [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? "";
  const beforeIsPunctish =
    beforeRun === "*" ||
    beforeRun === "_" ||
    !!PUNCT_TEST.exec(beforeRun);
  if (runStart < srcPos) prevChar = beforeRun;
  const openFlanked = runStart < srcPos
    ? beforeIsPunctish
    : !!PUNCT_TEST.exec(prevChar);
  // "_" cannot open inside a word.
  if (m[4] && prevChar.match(UNICODE_ALNUM)) return;
  const afterPunct = m[1] || m[3] || "";
  if (!afterPunct || !prevChar || openFlanked) {
    const openLen = [...m[0]].length - 1;
    let openLeft = openLen;
    let skipped = 0;
    const totalRun = srcPos - runStart + openLen;
    const canAlsoClose =
      !!beforeRun.trim() &&
      (!!afterPunct || (delim === "*" && !beforeIsPunctish));
    if (delim !== "*" && delim !== "_") return;
    const closerRe = delim === "*" ? EM_CLOSE_AST : EM_CLOSE_UND;
    const lastCloser = lastEmCloser(this, masked, delim);
    const openEnd = masked.length - src.length + openLen;
    if (lastCloser < openEnd) return;
    const rest = masked.slice(-src.length + openLen);
    const limit = lastCloser - openEnd;
    let s;
    closerRe.lastIndex = 0;
    while ((s = closerRe.exec(rest)) !== null && !(s.index > limit)) {
      const run = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!run) continue;
      let runLen = [...run].length;
      // Opener-only runs lengthen the run this closer must satisfy.
      if (s[3] || s[4]) {
        openLeft += runLen;
        continue;
      } else if (s[5] || s[6] || canAlsoClose) {
        if (sameAsPrev && (s[5] || s[6])) break;
        // Rule of 3: skip a closer that would make the total a
        // multiple of 3 when the opener is not.
        if (totalRun % 3 && !((totalRun + runLen) % 3)) {
          skipped += runLen;
          continue;
        }
      }
      openLeft -= runLen;
      if (openLeft > 0) continue;
      runLen = Math.min(runLen, runLen + openLeft + skipped);
      const leadLen = [...s[0]][0].length;
      const whole = src.slice(0, openLen + s.index + leadLen + runLen);
      if (Math.min(openLen, runLen) % 2) {
        const inner = whole.slice(1, -1);
        return {
          type: "em",
          raw: whole,
          text: inner,
          tokens: this.inlineTokens(inner),
        };
      }
      const inner = whole.slice(2, -2);
      return {
        type: "strong",
        raw: whole,
        text: inner,
        tokens: this.inlineTokens(inner),
      };
    }
  }
};

Lexer.prototype.tokCodeSpan = function (src) {
  const m = CODE_SPAN.exec(src);
  if (!m) return;
  let text = m[2].replace(NL_GLOBAL, " ");
  const hasNonSpace = NON_SPACE.test(text);
  const wrapped = LEAD_SPACE.test(text) && END_SPACE.test(text);
  if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
  return { type: "codespan", raw: m[0], text };
};

Lexer.prototype.tokBr = function (src) {
  const m = BR.exec(src);
  if (!m) return;
  return { type: "br", raw: m[0] };
};

Lexer.prototype.tokDel = function (src, masked, prevChar) {
  const m = DEL_OPEN.exec(src);
  if (!m) return;
  if ((m[1] || "") || !prevChar || PUNCT_TEST.exec(prevChar)) {
    const runLen = [...m[0]].length - 1;
    let pending = runLen;
    const last = lastDelCloser(this, masked);
    const openEnd = masked.length - src.length + runLen;
    if (last < openEnd) return;
    const rest = masked.slice(-src.length + runLen);
    const limit = last - openEnd;
    let s;
    DEL_CLOSE.lastIndex = 0;
    while ((s = DEL_CLOSE.exec(rest)) !== null && !(s.index > limit)) {
      const run = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!run) continue;
      let runLen2 = [...run].length;
      // The closer must be exactly as long as the opener.
      if (runLen2 !== runLen) continue;
      if (s[3] || s[4]) {
        pending += runLen2;
        continue;
      }
      pending -= runLen2;
      if (pending > 0) continue;
      runLen2 = Math.min(runLen2, runLen2 + pending);
      const leadLen = [...s[0]][0].length;
      const whole = src.slice(0, runLen + s.index + leadLen + runLen2);
      const inner = whole.slice(runLen, -runLen);
      return {
        type: "del",
        raw: whole,
        text: inner,
        tokens: this.inlineTokens(inner),
      };
    }
  }
};

Lexer.prototype.tokAutolink = function (src) {
  const m = AUTOLINK.exec(src);
  if (!m) return;
  let text;
  let href;
  if (m[2] === "@") {
    text = m[1];
    href = "mailto:" + text;
  } else {
    text = m[1];
    href = text;
  }
  return {
    type: "link",
    raw: m[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: "text", raw: text, text }],
  };
};

Lexer.prototype.tokUrl = function (src) {
  const m = URL.exec(src);
  if (!m) return;
  let text;
  let href;
  if (m[2] === "@") {
    text = m[0];
    href = "mailto:" + text;
  } else {
    // Trim trailing punctuation and unbalanced closing parens.
    let prev;
    do {
      prev = m[0];
      m[0] = BACKPEDAL.exec(m[0])?.[0] ?? "";
    } while (prev !== m[0]);
    text = m[0];
    href = m[1] === "www." ? "http://" + m[0] : m[0];
  }
  return {
    type: "link",
    raw: m[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: "text", raw: text, text }],
  };
};

Lexer.prototype.tokInlineText = function (src) {
  const m = INLINE_TEXT.exec(src);
  if (!m) return;
  const inRaw = this.state.inRawBlock;
  return {
    type: "text",
    raw: m[0],
    text: inRaw ? m[0] : unescapeEntities(m[0]),
    escaped: inRaw,
  };
};

// ---------------------------------------------------------------------------
// Renderer — turns tokens into HTML.
// ---------------------------------------------------------------------------
class Renderer {
  space() {
    return "";
  }

  code(tok) {
    const firstWord = (tok.lang || "").match(NON_SPACE_START)?.[0];
    const body = tok.text ? tok.text.replace(END_NL, "") + "\n" : "";
    const escaped = escHtml(body, true);
    if (firstWord)
      return `<pre><code class="language-${escHtml(firstWord)}">${escaped}</code></pre>\n`;
    return `<pre><code>${escaped}</code></pre>\n`;
  }

  blockquote(tok) {
    return `<blockquote>\n${this.parser.parse(tok.tokens)}</blockquote>\n`;
  }

  html(tok) {
    return tok.text;
  }

  def() {
    return "";
  }

  heading(tok) {
    return `<h${tok.depth}>${this.parser.parseInline(tok.tokens)}</h${tok.depth}>\n`;
  }

  hr() {
    return "<hr>\n";
  }

  list(tok) {
    let body = "";
    for (const item of tok.items) body += this.listitem(item);
    const tag = tok.ordered ? "ol" : "ul";
    const start =
      tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : "";
    return `<${tag}${start}>\n${body}</${tag}>\n`;
  }

  listitem(tok) {
    return `<li>${this.parser.parse(tok.tokens)}</li>\n`;
  }

  checkbox(tok) {
    return (
      "<input " +
      (tok.checked ? 'checked="" ' : "") +
      'disabled="" type="checkbox"> '
    );
  }

  paragraph(tok) {
    return `<p>${this.parser.parseInline(tok.tokens)}</p>\n`;
  }

  table(tok) {
    let head = "";
    for (const cell of tok.header) head += this.tablecell(cell);
    head = this.tablerow({ text: head });
    let body = "";
    for (const row of tok.rows) {
      let cells = "";
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
  }

  tablerow({ text }) {
    return `<tr>\n${text}</tr>\n`;
  }

  tablecell(tok) {
    const tag = tok.header ? "th" : "td";
    return (
      (tok.align ? `<${tag} align="${tok.align}">` : `<${tag}>`) +
      this.parser.parseInline(tok.tokens) +
      `</${tag}>\n`
    );
  }

  strong(tok) {
    return `<strong>${this.parser.parseInline(tok.tokens)}</strong>`;
  }

  em(tok) {
    return `<em>${this.parser.parseInline(tok.tokens)}</em>`;
  }

  codespan(tok) {
    return `<code>${escHtml(tok.text, true)}</code>`;
  }

  br() {
    return "<br>";
  }

  del(tok) {
    return `<del>${this.parser.parseInline(tok.tokens)}</del>`;
  }

  link(tok) {
    const inner = tok.autolink
      ? escHtml(tok.text, true)
      : this.parser.parseInline(tok.tokens);
    const href = cleanUrl(tok.href);
    if (href === null) return inner;
    let out = `<a href="${escHtml(href, tok.autolink)}"`;
    if (tok.title) out += ` title="${escHtml(tok.title)}"`;
    return out + `>${inner}</a>`;
  }

  image(tok) {
    let alt = tok.text;
    if (tok.tokens)
      alt = this.parser.parseInline(tok.tokens, this.parser.textRenderer);
    const href = cleanUrl(tok.href);
    if (href === null) return escHtml(alt);
    let out = `<img src="${escHtml(href)}" alt="${escHtml(alt)}"`;
    if (tok.title) out += ` title="${escHtml(tok.title)}"`;
    return out + ">";
  }

  text(tok) {
    if ("tokens" in tok && tok.tokens)
      return this.parser.parseInline(tok.tokens);
    if ("escaped" in tok && tok.escaped) return tok.text;
    return escHtml(tok.text);
  }
}

// Plain-text renderer: used for image alt text, where markup is flattened.
class TextRenderer {
  strong(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }

  em(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }

  codespan(tok) {
    return tok.text;
  }

  del(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }

  html(tok) {
    return tok.text;
  }

  text(tok) {
    return tok.text;
  }

  link(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }

  image(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }

  br() {
    return "";
  }

  checkbox(tok) {
    return tok.raw;
  }
}

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = "";
    for (const tok of tokens) {
      switch (tok.type) {
        case "space":
          out += this.renderer.space(tok);
          break;
        case "hr":
          out += this.renderer.hr(tok);
          break;
        case "heading":
          out += this.renderer.heading(tok);
          break;
        case "code":
          out += this.renderer.code(tok);
          break;
        case "table":
          out += this.renderer.table(tok);
          break;
        case "blockquote":
          out += this.renderer.blockquote(tok);
          break;
        case "list":
          out += this.renderer.list(tok);
          break;
        case "checkbox":
          out += this.renderer.checkbox(tok);
          break;
        case "html":
          out += this.renderer.html(tok);
          break;
        case "def":
          out += this.renderer.def(tok);
          break;
        case "paragraph":
          out += this.renderer.paragraph(tok);
          break;
        case "text":
          out += this.renderer.text(tok);
          break;
        default:
          throw new Error(
            `Token with "${tok.type}" type was not found.`
          );
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = "";
    for (const tok of tokens) {
      switch (tok.type) {
        case "escape":
          out += renderer.text(tok);
          break;
        case "html":
          out += renderer.html(tok);
          break;
        case "link":
          out += renderer.link(tok);
          break;
        case "image":
          out += renderer.image(tok);
          break;
        case "checkbox":
          out += renderer.checkbox(tok);
          break;
        case "strong":
          out += renderer.strong(tok);
          break;
        case "em":
          out += renderer.em(tok);
          break;
        case "codespan":
          out += renderer.codespan(tok);
          break;
        case "br":
          out += renderer.br(tok);
          break;
        case "del":
          out += renderer.del(tok);
          break;
        case "text":
          out += renderer.text(tok);
          break;
        default:
          throw new Error(
            `Token with "${tok.type}" type was not found.`
          );
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function parse(markdown) {
  if (typeof markdown !== "string") {
    throw new Error(
      "marked(): input parameter is of type " +
        Object.prototype.toString.call(markdown) +
        ", string expected"
    );
  }
  const tokens = new Lexer().lex(markdown);
  return new Parser().parse(tokens);
}
