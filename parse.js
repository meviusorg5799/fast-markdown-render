// Fast Markdown renderer — a from-scratch reimplementation of the CommonMark 0.31.2 +
// GFM 0.29 parsing behaviour of marked 18.1.3 with its default options
// (gfm: true, breaks: false, pedantic: false, async: false).
// Written independently for the make.fun "Make Markdown rendering faster" bounty.
// It computes every output from the input string alone; no caching across calls.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Small regex builder: substitute named placeholders with sources, like a template.
// Keys are matched literally (not as regexes), every occurrence. A leading ^ in
// a substituted source is dropped (it would anchor the composite pattern to the
// start of the string, where the placeholder sits mid-pattern).
function build(re, subs, flags) {
  let src = typeof re === 'string' ? re : re.source;
  if (subs) {
    for (const k of Object.keys(subs)) {
      let v = typeof subs[k] === 'string' ? subs[k] : subs[k].source;
      v = v.replace(/(^|[^\[])\^/g, '$1');
      src = src.split(k).join(v);
    }
  }
  return new RegExp(src, flags);
}

// ---------- generic helpers ----------
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const numericRef = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(html, encode) {
  if (encode) {
    if (escapeTest.test(html)) return html.replace(escapeReplace, (c) => ESCAPES[c]);
  } else if (escapeTestNoEncode.test(html)) {
    return html.replace(escapeReplaceNoEncode, (c) => (c === '&' ? '&amp;' : ESCAPES[c]));
  }
  return html;
}

function unescapeHtml(html) {
  if (!numericRef.test(html)) return html;
  return html.replace(numericRefOrAmp, (_m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// rtrim `src` of trailing `ch` characters; if `keep` is set, keep trimming while the
// char before is not in `keep`... (marked's rtrim: strips trailing ch unless the
// character before the run is in the keep set — here used only with ch='#').
function rtrim(src, ch) {
  const n = src.length;
  if (n === 0) return '';
  let i = 0;
  for (; i < n; ) {
    const c = src.charAt(n - i - 1);
    if (c === ch) i++;
    else break;
  }
  return src.slice(0, n - i);
}

// Remove trailing blank lines, keeping at most one trailing blank line.
function trimTrailingBlanks(src) {
  const lines = src.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]); ) t--;
  return lines.length - t <= 2 ? src : lines.slice(0, t + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing bracket matching the opening bracket at 0 of
// `src` (which starts with the opening char), respecting backslash escapes.
// Returns the index, -2 if unclosed with depth > 0, -1 otherwise.
function findClosingBracket(src, open, close) {
  if (src.indexOf(open) === -1 && src.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, counting columns from `startCol`.
function expandTabs(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row into cells, honouring \| escapes and trimming outer pipes.
function splitCells(row, count) {
  const cells = row
    .replace(/\|/g, (m, off, s) => {
      let escaped = false;
      let p = off;
      for (; --p >= 0 && s[p] === '\\'; ) escaped = !escaped;
      return escaped ? '|' : ' |';
    })
    .split(' |');
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------- block regexes ----------
const bullRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const hrRe = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
// The same pattern without its capturing group, for embedding in other regexes.
const hrPattern = ' {0,3}(?:(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const fencesRe = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const codeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const htmlCommentRe = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const blockHtmlRe = build(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!prescript)([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  {
    comment: htmlCommentRe,
    tag: BLOCK_TAGS,
    prescript: '(?:script|pre|style|textarea)(?![a-z0-9-])',
    attribute: / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  },
  'i',
);
const blockHtmlBeginRe = build(
  '^ {0,3}(?:</?(?:tag)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  { tag: BLOCK_TAGS },
  'i',
);
const blockquoteStartRe = /^ {0,3}>/;
const blankLineRe = /^[ \t]*$/;
const doubleBlankRe = /\n[ \t]*\n[ \t]*$/;
const anyLineRe = /\n.*\n/;
const nonSpaceRe = /[^ ]/;
const notSpaceStartRe = /^\S*/;
const listItemRe = (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`);
const listIsTaskRe = /^\[[ xX]\][ \t]+\S/;
const listReplaceTaskRe = /^\[[ xX]\][ \t]+/;
const listTaskCheckboxRe = /\[[ xX]\]/;
// Nested-block regexes take the list indent but clamp it to at most 3 leading
// spaces (the indent minus one, floored at 0, capped at 3).
function clampIndent(fn) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return cache[n] || (cache[n] = fn(n));
  };
}
const nextBulletRe = clampIndent((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrReN = clampIndent((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = clampIndent((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRe = clampIndent((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = clampIndent((n) => build(`^ {0,${n}}(?:</?(?:tag)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, { tag: BLOCK_TAGS }, 'i'));
const blockquoteBeginRe = clampIndent((n) => new RegExp(`^ {0,${n}}>`));

// label / title fragments used by link reference definitions and inline links
const labelFrag = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const labelGuardFrag = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const titleFrag = /(?:\"(?:\\[\s\S]|[^"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const defRe = build(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
  { label: labelGuardFrag, title: titleFrag },
);

// Paragraph / setext heading / table (GFM)
const paraCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function paragraphRe(listBull) {
  return build(paraCore, {
    '|lheading': '',
    hr: hrPattern,
    heading: ' {0,3}#{1,6}(?:\\s|$)',
    table: tableRe,
    blockquote: ' {0,3}>',
    fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    list: listBull,
    html: build(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', { tag: BLOCK_TAGS }),
  });
}
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingRe = build(lheadingCore, {
  bull: bullRe,
  blockCode: /(?: {4}| {0,3}\t)/,
  fences: ' {0,3}(?:`{3,}|~{3,})',
  blockquote: ' {0,3}>',
  heading: ' {0,3}#{1,6}(?:\\s|$)',
  hr: hrPattern,
  html: ' {0,3}<[^\\n>]+>\\n',
  table: ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n',
});
const tableRe = build(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
  {
    hr: hrPattern,
    heading: ' {0,3}#{1,6}(?:\\s|$)',
    blockquote: ' {0,3}>',
    code: '(?: {4}| {0,3}\t)[^\\n]',
    fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    list: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
    html: build(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', { tag: BLOCK_TAGS }),
  },
);
const paraGfmLoose = paragraphRe(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
const paraGfmStrict = paragraphRe(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)');
const listRe = build(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, { bull: bullRe });
const blockquoteRe = build(
  /^((?: {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+)/,
  { paragraph: paraGfmStrict },
);

// ---------- inline regexes ----------
const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const codeSpanRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const tagRe = build(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  {
    comment: build(/<!--(?:-?>|[\s\S]*?(?:-->))/),
    attribute: /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  },
);
const autolinkRe = build(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, {
  scheme: /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/,
  email: /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
});
const bracketsRe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const linkLabelRe = build(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  { brackets: bracketsRe },
);
const linkRe = build(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
  {
    label: linkLabelRe,
    href: /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/,
    title: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
  },
);
const reflinkRe = build(/^!?\[(label)\]\[(ref)\]/, { label: linkLabelRe, ref: labelGuardFrag });
const nolinkRe = build(/^!?\[(ref)\](?:\[\])?/, { ref: labelGuardFrag });
const reflinkSearchLabel = build(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  { brackets: bracketsRe },
);
const reflinkSearchRe = build('reflink|nolink(?!\\()', {
  reflink: build(/^!?\[(label)\]\[(ref)\]/, { label: reflinkSearchLabel, ref: /(?:\\[\s\S]|[^\[\]\\]){1,999}/ }),
  nolink: build(/^!?\[(ref)\](?:\[\])?/, { ref: /(?:\\[\s\S]|[^\[\]\\]){1,999}/ }),
}, 'g');
const punctRe = /[\p{P}\p{S}]/u;
const punctSpaceRe = /[\s\p{P}\p{S}]/u;
const notPunctSpaceRe = /[^\s\p{P}\p{S}]/u;
const emLDelimRe = build(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, { punct: /[\p{P}\p{S}]/u }, 'u');
const emLDelimGfmRe = build(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, { punct: /(?!~)[\p{P}\p{S}]/u }, 'u');
// Right-delimiter scanners for * and _ (GFM variants, with ~ excluded from punctuation).
// Groups 3/4 are opening runs, 5/6 closing runs; the group index decides.
const emRDelimAstSrc =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const emRDelimUndSrc =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
function emRDelim(reSrc) {
  return build(reSrc, {
    notPunctSpace: /(?:[^\s\p{P}\p{S}]|~)/u,
    punctSpace: /(?!~)[\s\p{P}\p{S}]/u,
    punct: /(?!~)[\p{P}\p{S}]/u,
  }, 'gu');
}
// The underscore and strikethrough right-delimiter scanners use the plain
// punctuation classes (a tilde counts as punctuation there).
function emRDelimNormal(reSrc) {
  return build(reSrc, {
    notPunctSpace: /[^\s\p{P}\p{S}]/u,
    punctSpace: /[\s\p{P}\p{S}]/u,
    punct: /[\p{P}\p{S}]/u,
  }, 'gu');
}
const emRDelimAstRe = emRDelim(emRDelimAstSrc);
const emRDelimUndRe = emRDelimNormal(emRDelimUndSrc);
const delLDelimRe = build(/^(~~?)(?=[^\s~])/, {}, 'u');
const delLDelimFullRe = build(/^~~?(?:((?!~)punct)|[^\s~])/, { punct: punctRe }, 'u');
const delRDelimRe = emRDelimNormal(
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)',
);
const anyPunctRe = build(/\\(punct)/, { punct: punctRe }, 'gu');
const anyPunctOutsideCodeRe = build(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, { punct: punctRe }, 'gu');
const emailRe = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const emailAtRe = /(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/;
const urlEmailRe = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const urlRe = build(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
  {
    emailProtocol: build(emailAtRe, { email: emailRe }),
    protocol: /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
    email: urlEmailRe,
  },
);
const urlBackpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const blockSkipRe = build(/link|precode-code|html/, {
  link: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  'precode-': /(?<!`)()/,
  code: /(?<b>`+)[^`]+\k<b>(?!`)/,
  html: /<(?! )[^<>]*?>/,
}, 'g');
const textRe = build(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  {
    emailProtocol: /(?:mailto|xmpp):/,
    protocol: /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
    wwwStart: /(?<![^\s*_~(])www\./,
  },
);
// ---------- block tokenization ----------

const codeRemoveIndentRe = /^(?: {0,3}\t| {1,4})/gm;
const indentCodeCompRe = /^(\s+)(?:```)/;
const beginningSpaceRe = /^\s+/;
const endingNewlineRe = /\n$/;
const leadingSpaceTabRe = /^[ \t]+/;
const tabCharRe = /\t/g;
const setextInQuoteRe = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const quoteMarkerRe = /^ {0,3}>[ \t]?/gm;
const quoteMarkerWsRe = /^( {0,3}>)([ \t]+)/gm;
const setextLineRe = /^ {0,3}(?:=+|-+) *$/;
const hrefBracketsRe = /^<(.*)>$/;
const startAngleRe = /^</;
const startATagRe = /^<a /i;
const endATagRe = /^<\/a>/i;
const startPreScriptRe = /^<(pre|code|kbd|script)(\s|>)/i;
const endPreScriptRe = /^<\/(pre|code|kbd|script)(\s|>)/i;
const tableAlignCharsRe = /^\||\| *$/g;
const tableAlignRightRe = /^ *-+: *$/;
const tableAlignCenterRe = /^ *:-+: *$/;
const tableAlignLeftRe = /^ *:-+ *$/;
const tableRowBlankRe = /\n[ \t]*$/;
const tableDelimRe = /[:|]/;

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }
  space(src) {
    const m = newlineRe.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }
  code(src) {
    const m = codeRe.exec(src);
    if (m) {
      const raw = trimTrailingBlanks(m[0]);
      const text = raw.replace(codeRemoveIndentRe, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
  }
  fences(src) {
    const m = fencesRe.exec(src);
    if (m) {
      const raw = m[0];
      let text = m[3] || '';
      const comp = indentCodeCompRe.exec(raw);
      if (comp) {
        const ind = comp[1];
        text = text
          .split('\n')
          .map((line) => {
            const sp = beginningSpaceRe.exec(line);
            if (sp === null) return line;
            return line.slice(Math.min(sp[0].length, ind.length));
          })
          .join('\n');
      }
      return {
        type: 'code',
        raw,
        lang: m[2] ? m[2].trim().replace(anyPunctRe, '$1') : m[2],
        text,
      };
    }
  }
  heading(src) {
    const m = headingRe.exec(src);
    if (m) {
      let text = m[2].trim();
      if (/#$/.test(text)) {
        const s = rtrim(text, '#');
        if (!s || /[ \t]$/.test(s)) text = s.trim();
      }
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, tokens: this.lexer.inline(text) };
    }
  }
  hr(src) {
    const m = hrRe.exec(src);
    if (m) return { type: 'hr', raw: rtrim(m[0], '\n') };
  }
  blockquote(src) {
    const m = blockquoteRe.exec(src);
    if (!m) return;
    let lines = rtrim(m[0], '\n').split('\n');
    let rawOut = '';
    let textOut = '';
    const tokens = [];
    while (lines.length > 0) {
      let started = false;
      const group = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (blockquoteStartRe.test(lines[p])) {
          group.push(lines[p]);
          started = true;
        } else if (!started) {
          group.push(lines[p]);
        } else break;
      }
      lines = lines.slice(p);
      const joined = group.join('\n');
      const stripped = joined
        .replace(quoteMarkerWsRe, (g, b, ws) => b + expandTabs(ws, b.length))
        .replace(setextInQuoteRe, '\n    $1')
        .replace(quoteMarkerRe, '');
      rawOut = rawOut ? `${rawOut}\n${joined}` : joined;
      textOut = textOut ? `${textOut}\n${stripped}` : stripped;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(stripped, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (!last) break;
      if (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table') break;
      if (last.type === 'blockquote') {
        const rest = lines.join('\n');
        const combined = `${last.raw}\n${rest.replace(quoteMarkerRe, '')}`;
        const reparsed = this.blockquote(combined);
        tokens[tokens.length - 1] = reparsed;
        const leftover = combined.substring(reparsed.raw.length).replace(/^\n/, '');
        const leftLines = leftover ? leftover.split('\n').length : 0;
        const consumed = leftLines ? lines.slice(0, -leftLines) : lines;
        if (consumed.length > 0) rawOut = `${rawOut}\n${consumed.join('\n')}`;
        textOut = textOut.substring(0, textOut.length - last.text.length) + reparsed.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && blockquoteStartRe.test(lines[0])) continue;
        break;
      } else if (last.type === 'list') {
        const rest = lines.join('\n');
        const combined = `${last.raw}\n${rest}`;
        const reparsed = this.list(combined);
        tokens[tokens.length - 1] = reparsed;
        const extra = reparsed.raw.length > last.raw.length ? combined.slice(last.raw.length + 1, reparsed.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const y = lines.slice(0, extra).join('\n');
          rawOut = `${rawOut}\n${y}`;
          textOut = `${textOut}\n${y}`;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw: rawOut, tokens, text: textOut };
  }
  list(src) {
    const m = listRe.exec(src);
    if (!m) return;
    const full = src;
    let cur = src;
    const pos = () => full.length - cur.length;
    const firstBullet = m[1].trim();
    const ordered = firstBullet.length > 1;
    const listTok = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +firstBullet.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    const bullPat = ordered ? `\\d{1,9}\\${firstBullet.slice(-1)}` : `\\${firstBullet}`;
    const itemRe = listItemRe(bullPat);
    let hadDoubleBlank = false;
    while (cur) {
      let isEmptyItem = false;
      let d = '';
      const mm = itemRe.exec(cur);
      if (!mm || hrRe.test(cur)) break;
      const startPos = pos();
      cur = cur.substring(mm[0].length);
      const firstLine = mm[2].split('\n', 1)[0];
      const bulletLen = mm[1].length;
      let body = firstLine.replace(leadingSpaceTabRe, (v) => expandTabs(v, bulletLen));
      const nextLine0 = cur.split('\n', 1)[0];
      let blankItem = !body.trim();
      let indent;
      if (blankItem) {
        indent = bulletLen + 1;
      } else {
        indent = body.search(nonSpaceRe);
        indent = indent > 4 ? 1 : indent;
        d = body.slice(indent);
        indent += bulletLen;
      }
      if (blankItem && blankLineRe.test(nextLine0)) {
        cur = cur.substring(nextLine0.length + 1);
        isEmptyItem = true;
      }
      if (!isEmptyItem) {
        const nextBull = nextBulletRe(indent);
        const hrN = hrReN(indent);
        const fencesN = fencesBeginRe(indent);
        const headN = headingBeginRe(indent);
        const htmlN = htmlBeginRe(indent);
        const quoteN = blockquoteBeginRe(indent);
        while (cur) {
          const line = cur.split('\n', 1)[0];
          const expanded = line.replace(leadingSpaceTabRe, (v) => expandTabs(v, 0));
          if (fencesN.test(line) || headN.test(line) || htmlN.test(line) || quoteN.test(line) || nextBull.test(line) || hrN.test(line)) break;
          if (expanded.search(nonSpaceRe) >= indent || !line.trim()) {
            d += `\n${expanded.slice(indent)}`;
          } else {
            if (blankItem || body.replace(tabCharRe, '    ').search(nonSpaceRe) >= 4 || fencesN.test(body) || headN.test(body) || htmlN.test(body) || hrN.test(body)) break;
            const qe =
              setextLineRe.test(line) && lheadingRe.test(`${body}\n${line}`)
                ? `    ${expanded.replace(/^ {0,3}/, '')}`
                : line;
            d += `\n${qe}`;
          }
          blankItem = !line.trim();
          cur = cur.substring(line.length + 1);
          body = expanded.slice(indent);
        }
      }
      const itemRaw = full.slice(startPos, pos());
      if (!listTok.loose) {
        if (hadDoubleBlank) listTok.loose = true;
        else if (doubleBlankRe.test(itemRaw)) hadDoubleBlank = true;
      }
      listTok.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: listIsTaskRe.test(d),
        loose: false,
        text: d,
        tokens: [],
      });
    }
    const lastItem = listTok.items[listTok.items.length - 1];
    if (!lastItem) return;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    listTok.raw = full.slice(0, pos()).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => anyLineRe.test(t.raw))) listTok.loose = true;
      }
    }
    for (const item of listTok.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(listReplaceTaskRe, '');
        first.raw = first.raw.replace(listReplaceTaskRe, '');
        first.text = first.text.replace(listReplaceTaskRe, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (listIsTaskRe.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(listReplaceTaskRe, '');
            break;
          }
        }
        const cb = listTaskCheckboxRe.exec(item.raw);
        if (cb) {
          const check = { type: 'checkbox', raw: `${cb[0]} `, checked: cb[0] !== '[ ]' };
          item.checked = check.checked;
          if (listTok.loose) {
            if (first && ['paragraph', 'text'].includes(first.type) && 'tokens' in first && first.tokens) {
              first.raw = check.raw + first.raw;
              first.text = check.raw + first.text;
              first.tokens.unshift(check);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: check.raw, text: check.raw, tokens: [check] });
            }
          } else {
            item.tokens.unshift(check);
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
    const m = blockHtmlRe.exec(src);
    if (m) {
      const raw = trimTrailingBlanks(m[0]);
      return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
    }
  }
  def(src) {
    const m = defRe.exec(src);
    if (m) {
      if (!startAngleRe.test(m[2]) && findClosingBracket(m[2], '(', ')') !== -1) return;
      const tag = normalizeLabel(m[1]);
      const href = m[2] ? m[2].replace(hrefBracketsRe, '$1').replace(anyPunctRe, '$1') : '';
      const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(anyPunctRe, '$1') : m[3];
      return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
    }
  }
  table(src) {
    const m = tableRe.exec(src);
    if (!m || !tableDelimRe.test(m[2])) return;
    const header = splitCells(m[1]);
    const aligns = m[2].replace(tableAlignCharsRe, '').split('|');
    const bodyLines = m[3] && m[3].trim() ? m[3].replace(tableRowBlankRe, '').split('\n') : [];
    const out = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
    if (header.length !== aligns.length) return;
    for (const a of aligns) {
      if (tableAlignRightRe.test(a)) out.align.push('right');
      else if (tableAlignCenterRe.test(a)) out.align.push('center');
      else if (tableAlignLeftRe.test(a)) out.align.push('left');
      else out.align.push(null);
    }
    for (let i = 0; i < header.length; i++) {
      out.header.push({ text: header[i], tokens: this.lexer.inline(header[i]), header: true, align: out.align[i] });
    }
    for (const line of bodyLines) {
      out.rows.push(
        splitCells(line, out.header.length).map((cell, j) => ({
          text: cell,
          tokens: this.lexer.inline(cell),
          header: false,
          align: out.align[j],
        })),
      );
    }
    return out;
  }
  lheading(src) {
    const m = lheadingRe.exec(src);
    if (m) {
      const text = m[1].trim();
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.lexer.inline(text) };
    }
  }
  paragraph(src) {
    const m = paraGfmLoose.exec(src);
    if (m) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
    }
  }
  text(src) {
    const m = /^[^\n]+/.exec(src);
    if (m) {
      return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
    }
  }
}

// ---------- inline tokenization ----------

const punctOnlyRe = /[\p{P}\p{S}]/u;
const punctSpaceOnlyRe = /[\s\p{P}\p{S}]/u;
const unicodeAlphaNumRe = /[\p{L}\p{N}]/u;
const outputLinkReplaceRe = /\\([\[\]])/g;

// Last-delimiter scan over a masked source: for each run of *, _ or ~, record the
// start of the last run whose preceding character is not whitespace.
function scanDelimiters(masked) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const ch = masked[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === ch; ) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = s;
      else lastEm[ch] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: masked, lastEm, lastDel };
}

// Per-tokenizer stack of delimiter scans, so a nested inline parse reuses the
// scan of the outer string it is a substring of.
const maskCache = new WeakMap();
function pushMask(tokenizer, masked) {
  const info = scanDelimiters(masked);
  let stack = maskCache.get(tokenizer);
  if (stack) stack.push(info);
  else maskCache.set(tokenizer, [info]);
  return info;
}
function popMask(tokenizer) {
  const stack = maskCache.get(tokenizer);
  if (stack) {
    stack.pop();
    if (stack.length === 0) maskCache.delete(tokenizer);
  }
}
function lastEmCloser(tokenizer, masked, ch) {
  const stack = maskCache.get(tokenizer);
  const top = stack && stack[stack.length - 1];
  if (top && top.maskedSrc === masked) return top.lastEm[ch];
  return scanDelimiters(masked).lastEm[ch];
}
function lastDelCloser(tokenizer, masked) {
  const stack = maskCache.get(tokenizer);
  const top = stack && stack[stack.length - 1];
  if (top && top.maskedSrc === masked) return top.lastDel;
  return scanDelimiters(masked).lastDel;
}

// Does the link text `text` (starting at offset `off` in `full`) contain a raw
// HTML tag or autolink that runs past the end of the text? If so the construct
// is not a link.
function linkTextHasTag(full, text, off) {
  if (!text.includes('<')) return false;
  for (let s = 0; s < text.length; s++) {
    if (text[s] === '\\') {
      s++;
      continue;
    }
    if (text[s] === '`') {
      const m = codeSpanRe.exec(text.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (text[s] !== '<') continue;
    const rest = full.slice(off + s);
    const m = tagRe.exec(rest) || autolinkRe.exec(rest);
    if (m) {
      if (m[0].length > text.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

function makeLinkToken(match, dest, raw, lexer) {
  const href = dest.href;
  const title = dest.title || null;
  const text = match[1].replace(outputLinkReplaceRe, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = lexer.state.inLink;
  const savedEmitted = lexer.state.linkEmitted;
  const savedRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const emittedInside = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (emittedInside) {
      lexer.state.inRawBlock = savedRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

class InlineTokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }
  escape(src) {
    const m = escapeRe.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  }
  tag(src) {
    const m = tagRe.exec(src);
    if (!m) return;
    const st = this.lexer.state;
    if (!st.inLink && startATagRe.test(m[0])) st.inLink = true;
    else if (st.inLink && endATagRe.test(m[0])) st.inLink = false;
    if (!st.inRawBlock && startPreScriptRe.test(m[0])) st.inRawBlock = true;
    else if (st.inRawBlock && endPreScriptRe.test(m[0])) st.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: m[0] };
  }
  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const m = linkRe.exec(src);
    if (!m) return;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasTag(src, m[1], bang)) return;
    let hrefPart = m[2].trim();
    if (startAngleRe.test(hrefPart)) {
      if (!/>$/.test(hrefPart)) return;
      const stripped = rtrim(hrefPart.slice(0, -1), '\\');
      if ((hrefPart.length - stripped.length) % 2 === 0) return;
    } else {
      const close = findClosingBracket(m[2], '(', ')');
      if (close === -2) return;
      if (close > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const rawNoTrail = rtrim(m[0].slice(0, -1), '\\');
    if ((m[0].length - rawNoTrail.length) % 2 === 0) return;
    let dest = m[2].trim();
    let title = '';
    if (m[3]) title = m[3].slice(1, -1);
    dest = dest.trim();
    if (startAngleRe.test(dest)) dest = dest.slice(1, -1);
    return makeLinkToken(
      m,
      {
        href: dest && dest.replace(anyPunctRe, '$1'),
        title: title && title.replace(anyPunctRe, '$1'),
      },
      m[0],
      this.lexer,
    );
  }
  reflink(src, links) {
    let m = reflinkRe.exec(src) || nolinkRe.exec(src);
    if (!m) return;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasTag(src, m[1], bang)) return;
    const dest = links[normalizeLabel(m[2] || m[1])];
    if (!dest) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return makeLinkToken(m, dest, m[0], this.lexer);
  }
  emStrong(src, masked, prevChar = '') {
    const m = emLDelimGfmRe.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    const delim = m[0][0];
    const sameAsPrev = prevChar === delim;
    const startIdx = masked.length - src.length;
    let scanFrom = startIdx;
    for (; scanFrom > 0 && masked[scanFrom - 1] === delim; ) scanFrom--;
    const beforeRun = [...masked.slice(Math.max(0, scanFrom - 2), scanFrom)].at(-1) ?? '';
    const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!punctSpaceOnlyRe.exec(beforeRun);
    if (scanFrom < startIdx) prevChar = beforeRun;
    const prevIsPunct = scanFrom < startIdx ? beforeIsPunct : !!punctSpaceOnlyRe.exec(prevChar);
    if (m[4] && unicodeAlphaNumRe.test(prevChar)) return;
    const afterPunct = m[1] || m[3] || '';
    if (!afterPunct || !prevChar || prevIsPunct) {
      const openLen = [...m[0]].length - 1;
      let g;
      let runLen;
      let openLeft = openLen;
      let spare = 0;
      const total = startIdx - scanFrom + openLen;
      const canAlsoClose = !!beforeRun.trim() && (!!afterPunct || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return;
      const scanRe = delim === '*' ? emRDelimAstRe : emRDelimUndRe;
      const lastCloser = lastEmCloser(this, masked, delim);
      const limit = masked.length - src.length + openLen;
      if (lastCloser < limit) return;
      let rest = masked.slice(-1 * src.length + openLen);
      const maxIdx = lastCloser - limit;
      scanRe.lastIndex = 0;
      let match;
      while ((match = scanRe.exec(rest)) !== null && !(match.index > maxIdx)) {
        g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!g) continue;
        runLen = [...g].length;
        if (match[3] || match[4]) {
          openLeft += runLen;
          continue;
        } else if (match[5] || match[6] || canAlsoClose) {
          if (sameAsPrev && (match[5] || match[6])) break;
          if (total % 3 && !((total + runLen) % 3)) {
            spare += runLen;
            continue;
          }
        }
        openLeft -= runLen;
        if (openLeft > 0) continue;
        runLen = Math.min(runLen, runLen + openLeft + spare);
        const firstLen = [...match[0]][0].length;
        const raw = src.slice(0, openLen + match.index + firstLen + runLen);
        if (Math.min(openLen, runLen) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }
  codespan(src) {
    const m = codeSpanRe.exec(src);
    if (!m) return;
    let text = m[2].replace(/\n/g, ' ');
    const hasNonSpace = /[^ ]/.test(text);
    const wrapped = /^ /.test(text) && / $/.test(text);
    if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }
  br(src) {
    const m = brRe.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  }
  del(src, masked, prevChar = '') {
    const m = delLDelimFullRe.exec(src);
    if (!m) return;
    if (!(m[1] || '') || !prevChar || punctSpaceOnlyRe.exec(prevChar)) {
      const openLen = [...m[0]].length - 1;
      let g;
      let runLen;
      let openLeft = openLen;
      const lastCloser = lastDelCloser(this, masked);
      const limit = masked.length - src.length + openLen;
      if (lastCloser < limit) return;
      let rest = masked.slice(-1 * src.length + openLen);
      const maxIdx = lastCloser - limit;
      delRDelimRe.lastIndex = 0;
      let match;
      while ((match = delRDelimRe.exec(rest)) !== null && !(match.index > maxIdx)) {
        g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!g) continue;
        runLen = [...g].length;
        if (runLen !== openLen) continue;
        if (match[3] || match[4]) {
          openLeft += runLen;
          continue;
        }
        openLeft -= runLen;
        if (openLeft > 0) continue;
        runLen = Math.min(runLen, runLen + openLeft);
        const firstLen = [...match[0]][0].length;
        const raw = src.slice(0, openLen + match.index + firstLen + runLen);
        const inner = raw.slice(openLen, -openLen);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }
  autolink(src) {
    const m = autolinkRe.exec(src);
    if (!m) return;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[1];
      href = `mailto:${text}`;
    } else {
      text = m[1];
      href = text;
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
  url(src) {
    const m = urlRe.exec(src);
    if (!m) return;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = `mailto:${text}`;
    } else {
      let cur = m[0];
      let prev;
      do {
        prev = cur;
        cur = urlBackpedalRe.exec(cur)?.[0] ?? '';
      } while (prev !== cur);
      text = cur;
      href = m[1] === 'www.' ? `http://${cur}` : cur;
    }
    return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
  inlineText(src) {
    const m = textRe.exec(src);
    if (!m) return;
    const inRaw = this.lexer.state.inRawBlock;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeHtml(m[0]), escaped: inRaw };
  }
}

// Does `src` contain a link (inline or reference) that would resolve? Used to
// mask link text in the delimiter scan.
function linkInText(lexer, src) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(blockSkipRe)) {
    if (linkRe.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(reflinkSearchRe)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(lexer.tokens.links, normalizeLabel(s.slice(r + 1, -1)))) &&
      !(r > 1 && linkInText(lexer, s.slice(1, r - 1)))
    ) {
      return true;
    }
  }
  return false;
}

// Build the masked source used for delimiter scanning: link texts, code spans
// and punctuation-after-backslash are neutralised so they cannot open/close.
function maskEmStrong(lexer, src) {
  let out = src;
  if (lexer.tokens.links && src.includes('[')) {
    const replaceFn = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(lexer.tokens.links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(lexer, inner)) return `[${inner.replace(reflinkSearchRe, replaceFn)}][${'a'.repeat(r.length - o - 2)}]`;
      }
      return `[${'a'.repeat(r.length - 2)}]`;
    };
    out = out.replace(reflinkSearchRe, replaceFn);
  }
  // The next two passes only change anything when the source holds a
  // backslash, a backtick, a link bracket or an angle bracket; skip them
  // entirely otherwise (same result, less work on long plain paragraphs).
  if (out.includes('\\') || out.includes('`')) {
    out = out.replace(anyPunctOutsideCodeRe, (n, ticks, punct) =>
      punct ? '+'.repeat(n.length) : ticks ? ticks + n.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks : n,
    );
  }
  if (out.includes('[') || out.includes('`') || out.includes('<')) {
    out = out.replace(blockSkipRe, (n, _a, b) => {
      const o = b ? b.length : 0;
      return n.slice(0, o) + `[${'a'.repeat(n.length - o - 2)}]`;
    });
  }
  return out;
}

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.inlineQueue = [];
    this.tokenizer = new Tokenizer(this);
    this.inlineTokenizer = new InlineTokenizer(this);
  }

  lex(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    this.blockTokens(src, this.tokens);
    for (const entry of this.inlineQueue) {
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens = [], inBlock = false) {
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    let mergeNext = inBlock;
    for (; src; ) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error(`Infinite loop on byte: ${src.charCodeAt(0)}`);
      let tok;
      if ((tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.code(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += `\n${tok.text}`;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
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
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += `\n${tok.raw}`;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          if (!this.tokens.links[tok.tag]) this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
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
        const prev = tokens[tokens.length - 1];
        if (mergeNext && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += `\n${tok.text}`;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          tokens.push(tok);
        }
        mergeNext = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += `\n${tok.text}`;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if (src) throw new Error(`Infinite loop on byte: ${src.charCodeAt(0)}`);
    }
    this.state.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.inlineTokensInner(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineTokensInner(src, tokens) {
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? maskEmStrong(this, src) : src;
    pushMask(this.inlineTokenizer, masked);
    try {
      return this.inlineLoop(src, masked, tokens);
    } finally {
      popMask(this.inlineTokenizer);
    }
  }

  inlineLoop(src, masked, tokens) {
    let wasText = false;
    let prevChar = '';
    let shortest = Infinity;
    let rest = src;
    for (; rest; ) {
      if (rest.length < shortest) shortest = rest.length;
      else throw new Error(`Infinite loop on byte: ${rest.charCodeAt(0)}`);
      if (!wasText) prevChar = '';
      wasText = false;
      let tok;
      if ((tok = this.inlineTokenizer.escape(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.tag(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.link(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.reflink(rest, this.tokens.links))) {
        rest = rest.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.type === 'text' && prev?.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.emStrong(rest, masked, prevChar))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.codespan(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.br(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.del(rest, masked, prevChar))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.autolink(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!this.state.inLink && (tok = this.inlineTokenizer.url(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.inlineTokenizer.inlineText(rest))) {
        rest = rest.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        wasText = true;
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if (rest) throw new Error(`Infinite loop on byte: ${rest.charCodeAt(0)}`);
    }
    return tokens;
  }
}

// ---------- rendering ----------

class Renderer {
  code({ text, lang, escaped }) {
    const firstWord = (lang || '').match(notSpaceStartRe)?.[0];
    const body = text ? text.replace(endingNewlineRe, '') + '\n' : '';
    const inner = escaped ? body : escapeHtml(body, true);
    return firstWord
      ? `<pre><code class="language-${escapeHtml(firstWord)}">${inner}</code></pre>\n`
      : `<pre><code>${inner}</code></pre>\n`;
  }
  blockquote({ tokens }) {
    return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
  }
  html({ text }) {
    return text;
  }
  def() {
    return '';
  }
  heading({ tokens, depth }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
  }
  hr() {
    return '<hr>\n';
  }
  list({ ordered, start, items }) {
    let body = '';
    for (const item of items) body += this.listitem(item);
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
    return `<${tag}${startAttr}>\n${body}</${tag}>\n`;
  }
  listitem(item) {
    return `<li>${this.parser.parse(item.tokens)}</li>\n`;
  }
  checkbox({ checked }) {
    return `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
  }
  paragraph({ tokens }) {
    return `<p>${this.parser.parseInline(tokens)}</p>\n`;
  }
  table({ header, rows }) {
    let headCells = '';
    for (const cell of header) headCells += this.tablecell(cell);
    let head = this.tablerow({ text: headCells });
    let body = '';
    for (const row of rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
  }
  tablerow({ text }) {
    return `<tr>\n${text}</tr>\n`;
  }
  tablecell(cell) {
    const inner = this.parser.parseInline(cell.tokens);
    const tag = cell.header ? 'th' : 'td';
    return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }
  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`;
  }
  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`;
  }
  codespan({ text }) {
    return `<code>${escapeHtml(text, true)}</code>`;
  }
  br() {
    return '<br>';
  }
  del({ tokens }) {
    return `<del>${this.parser.parseInline(tokens)}</del>`;
  }
  link({ href, title, text, tokens, autolink }) {
    const inner = autolink ? escapeHtml(text, true) : this.parser.parseInline(tokens);
    const cleaned = cleanUrl(href);
    if (cleaned === null) return inner;
    const url = escapeHtml(cleaned, autolink);
    let out = `<a href="${url}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    return `${out}>${inner}</a>`;
  }
  image({ href, title, text, tokens }) {
    if (tokens) text = this.parser.parseInline(tokens, this.parser.textRenderer);
    const cleaned = cleanUrl(href);
    if (cleaned === null) return escapeHtml(text);
    let out = `<img src="${escapeHtml(cleaned)}" alt="${escapeHtml(text)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    return `${out}>`;
  }
  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
    if ('escaped' in token && token.escaped) return token.text;
    return escapeHtml(token.text);
  }
}

// Plain-text renderer used for image alt text: inline tokens collapse to text.
class TextRenderer {
  strong({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }
  em({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }
  codespan({ text }) {
    return text;
  }
  del({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }
  html({ text }) {
    return text;
  }
  text({ text }) {
    return text;
  }
  link({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }
  image({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }
  br() {
    return '';
  }
  checkbox({ raw }) {
    return raw;
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
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space': break;
        case 'hr': out += this.renderer.hr(token); break;
        case 'heading': out += this.renderer.heading(token); break;
        case 'code': out += this.renderer.code(token); break;
        case 'table': out += this.renderer.table(token); break;
        case 'blockquote': out += this.renderer.blockquote(token); break;
        case 'list': out += this.renderer.list(token); break;
        case 'checkbox': out += this.renderer.checkbox(token); break;
        case 'html': out += this.renderer.html(token); break;
        case 'def': out += this.renderer.def(token); break;
        case 'paragraph': out += this.renderer.paragraph(token); break;
        case 'text': out += this.renderer.text(token); break;
        default: throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }
  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'escape': out += renderer.text(token); break;
        case 'html': out += renderer.html(token); break;
        case 'link': out += renderer.link(token); break;
        case 'image': out += renderer.image(token); break;
        case 'checkbox': out += renderer.checkbox(token); break;
        case 'strong': out += renderer.strong(token); break;
        case 'em': out += renderer.em(token); break;
        case 'codespan': out += renderer.codespan(token); break;
        case 'br': out += renderer.br(token); break;
        case 'del': out += renderer.del(token); break;
        case 'text': out += renderer.text(token); break;
        default: throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }
}

/** The HTML marked 18.1.3 renders for `markdown` with its default options. */
export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return new Parser().parse(tokens);
}
