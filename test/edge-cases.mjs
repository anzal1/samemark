// Edge inputs, each compared to mdast-util-from-markdown + GFM (full tree, positions included).
// Cases that only run with BIG=1 (CI) are marked `big`.
const rep = (s, n) => s.repeat(n)
const DOC = '# Title\n\nSome *emphasis*, **strong**, `code`, a [link](http://a.b "t") and ![img](i.png).\n\n- one\n- two\n  - nested\n\n> quote\n\n```js\nlet a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nText with footnote[^1] and ~~strike~~ and https://example.com.\n\n[^1]: The note.\n'
const withEol = eol => DOC.replace(/\n/g, eol)

export const groups = {
  'line endings': {
    'CRLF document': withEol('\r\n'),
    'CR document (lone CR)': withEol('\r'),
    'mixed LF CRLF CR': 'a\r\nb\nc\rd\r\n\r\n- x\r- y\n\r\n> q\r\n> r\n',
    'CR then LF split across blocks': '```\r\ncode\r\n\r\n```\r\n\r\n    indented\r\n    more\r\n',
    'CRLF hard break and trailing spaces': 'a  \r\nb\\\r\nc \r\nd\r\n',
    'CRLF table': '| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n| 3 | 4 |\r\n',
    'CRLF setext and thematic': 'Title\r\n=====\r\n\r\n***\r\n\r\nSub\r\n---\r\n',
    'CRLF html block': '<div>\r\n\r\nx\r\n</div>\r\n\r\n<!-- c\r\n-->\r\n',
    'CRLF list tight and loose': '- a\r\n- b\r\n\r\n- c\r\n\r\n1. x\r\n\r\n   y\r\n',
    'CRLF footnote definition': 'a[^1]\r\n\r\n[^1]: one\r\n\r\n    two\r\n',
    'CRLF multi-line link and reference': '[a\r\nb](u\r\n"t\r\nt")\r\n\r\n[r]: /u\r\n  "t"\r\n\r\n[r]\r\n',
    'lone CR inside code span and html text': '`a\rb` <a\rb="c"> *x\ry*\r',
    'trailing CR only': 'a\r',
    'only CR': '\r',
    'only CRLF': '\r\n',
    'CR CR LF': 'a\r\r\nb\n',
    'CRLF in tab-indented list': '-\ta\r\n\tb\r\n\r\n\tc\r\n'
  },
  'BOM': {
    'BOM then heading': '﻿# hi\n',
    'BOM only': '﻿',
    'BOM then newline': '﻿\n',
    'two BOMs': '﻿﻿a\n',
    'BOM in the middle': 'a﻿b\n\n﻿# c\n',
    'BOM then CRLF document': '﻿' + withEol('\r\n'),
    'BOM before list and indented code': '﻿    code\n\n﻿- a\n',
    'BOM then fence': '﻿```js\nx\n```\n',
    'BOM then front-matter looking text': '﻿---\ntitle: a\n---\n\nbody\n'
  },
  'NUL (U+0000 replaced by U+FFFD)': {
    'NUL in text': 'a\0b\n',
    'only NUL': '\0',
    'NUL at start of heading': '\0# h\n',
    'NUL in code span and fence': '`a\0b`\n\n```\0x\n\0\n```\n',
    'NUL in link destination, title, label': '[a\0](b\0 "c\0")\n\n[d\0]: e\0 "f\0"\n\n[d\0]\n',
    'NUL in html': '<a\0b>\n\n<div\0>\nx\n</div>\n',
    'NUL in autolink and entity': '<http://a\0b> &am\0p; &#0; &#x0;\n',
    'NUL in indentation': '\0    code\n\n -\0 a\n',
    'NUL in table': '| a\0 | b |\n|--|--|\n| \0 | c |\n',
    'NUL in emphasis flanking': '*\0a* _a\0_ **\0**\n',
    'many NULs': rep('\0', 1000) + '\n'
  },
  'empty and whitespace only': {
    'empty': '',
    'one space': ' ',
    'one tab': '\t',
    'newline': '\n',
    'many newlines': rep('\n', 1000),
    'spaces and newlines': '   \n  \n \n',
    'tabs and newlines': '\t\n\t\t\n\t',
    'whitespace then text': '   \n\n  a',
    'nbsp line': ' \n',
    'unicode spaces line': ' 　 \n',
    'form feed and vertical tab': '\f\n\v\na\n',
    'space only lines in a list': '- a\n  \n  \n- b\n \n',
    'trailing whitespace at EOF': 'a   ',
    'whitespace only code block': '    \n    \n',
    'whitespace in blockquote': '>  \n>\n> \n'
  },
  'very long lines': {
    '50k plain text': rep('a', 50000) + '\n',
    '25k words': rep('word ', 25000) + '\n',
    '50k stars unmatched': rep('*', 50000) + '\n',
    '10k star-letter pairs': rep('*a ', 10000) + '\n',
    '10k underscore pairs': rep('_a_ ', 10000) + '\n',
    '10k emphasis spans': rep('*a* ', 10000) + '\n',
    '10k open brackets': rep('[', 10000) + '\n',
    '10k links': rep('[a](b) ', 5000) + '\n',
    '10k backticks': rep('`', 10000) + '\n',
    '5k code spans': rep('`a` ', 5000) + '\n',
    '5k unmatched backticks of growing length': Array.from({length: 300}, (_, i) => rep('`', i + 1)).join(' a ') + '\n',
    'long table row': '| ' + rep('a | ', 2000) + '\n| ' + rep('- | ', 2000) + '\n| ' + rep('b | ', 2000) + '\n',
    'long heading': '# ' + rep('h ', 20000) + '\n',
    'long link destination': '[a](' + rep('x', 30000) + ')\n',
    'long html tag': '<a ' + rep('b="c" ', 5000) + '>\n',
    'long autolink literal': 'www.' + rep('a.', 5000) + 'com ' + rep('a', 5000) + '@b.c\n',
    'long line without trailing newline': rep('x ', 30000),
    '20k short lines': rep('a\n', 20000),
    '20k blank-separated paragraphs': rep('a\n\n', 10000)
  },
  'deep nesting': {
    'blockquote depth 100': rep('>', 100) + ' a\n',
    'blockquote depth 1000': rep('> ', 1000) + 'a\n',
    'list depth 50': Array.from({length: 50}, (_, i) => rep('  ', i) + '- a').join('\n') + '\n',
    'list depth 200': Array.from({length: 200}, (_, i) => rep(' ', i * 2) + '- a').join('\n') + '\n',
    'one-line list depth 200': rep('- ', 200) + 'a\n',
    'one-line list depth 1000': rep('- ', 1000) + 'a\n',
    'ordered list depth 200 one line': rep('1. ', 200) + 'a\n',
    'mixed bq and list depth 500': rep('> - ', 500) + 'a\n',
    'footnote definition nesting': rep('[^1]: ', 100) + 'a\n',
    'emphasis nesting 500': rep('*a ', 500) + 'b' + rep('* ', 500) + '\n',
    'emphasis nesting alternating': rep('*_', 300) + 'a' + rep('_*', 300) + '\n',
    'link nesting in brackets 1000': rep('[', 1000) + 'a' + rep('](u)', 1000) + '\n',
    'image nesting 500': rep('![', 500) + 'a' + rep('](u)', 500) + '\n',
    'strike nesting': rep('~~a ', 300) + rep('~~ ', 300) + '\n',
    'parens in destination 500': '[a](' + rep('(', 500) + 'x' + rep(')', 500) + ')\n',
    'nested html tags': rep('<div>\n', 500) + 'x\n',
    'bq in list in bq in list x100': rep('> - ', 100) + '```\ncode\n',
    'table inside deep quote': rep('> ', 100) + '| a |\n' + rep('> ', 100) + '|---|\n' + rep('> ', 100) + '| b |\n'
  },
  'unicode': {
    'astral next to star': '*😀* **😀** _😀_ a*😀*b 😀**a**😀\n',
    'astral punctuation flanking': '*𝔘𝔫𝔦* **𝄞**a _𝄞_\n',
    'combining marks': 'é*é* *́a* á̈_b́_ [é]: x\n',
    'combining mark in reference label': '[Café]\n\n[CAFÉ]: /u\n',
    'case folding in labels': '[ẞ] [SS] [ǅ] [İ] [ß] [Σ] [ς]\n\n[ss]: /a\n[ǆ]: /b\n[i̇]: /c\n[σ]: /d\n',
    'RTL text': 'שלום *עולם* مرحبا **بالعالم** [רשימה](u)\n\n- שלום\n- مرحبا\n',
    'CJK punctuation': '**「強調」**と*『強調』*。**（強調）**だ。\n',
    'CJK flanking': '日本語**強調**日本語 日本語_強調_日本語\n',
    'zero width chars': 'a​*b*‌ _c_‍ ⁠**d**﻿\n',
    'line and paragraph separators': 'a b c\u0085d\n\n# h x\n',
    'nbsp around emphasis': ' *a*  * a *\n',
    'unicode whitespace around emphasis': ' *a*  * a * 　_b_　\n',
    'fullwidth markers and digits': '＊a＊ ＿b＿ １．x ＞q ＃h\n',
    'emoji with variation selectors and ZWJ': '👨‍👩‍👧*x*❤️**y**\n',
    'astral in link destination and title': '[a](😀 "😀") <http://😀.example> https://😀.example/😀\n',
    'astral in table cells': '| 😀 | 𝔘 |\n|---|---|\n| 𝄞 | a |\n',
    'astral in code span and fence': '`😀` ``𝔘 `x` 𝔘``\n\n```😀\n𝔘\n```\n',
    'astral in heading id style text': '# 😀 *𝔘* [𝄞](u)\n',
    'astral at line start with indent': '    😀\n  𝔘 a\n- 😀\n  𝄞\n',
    'emoji tag sequences': '*🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}* a\n',
    'unicode in footnote id': 'a[^é] b[^😀]\n\n[^é]: x\n[^😀]: y\n',
    'unicode in email and www autolinks': 'bé@example.com é@b.c www.é.com www.example.com/é\n',
    'entities for astral': '&#x1F600; &#128512; &#xD800; &#55296; &#x110000; &#1114112; &#x10FFFF;\n'
  },
  'lone surrogates': {
    'lone high surrogate': 'a\ud800b\n',
    'lone low surrogate': 'a\udc00b\n',
    'reversed pair': '\udc00\ud800\n',
    'high surrogate alone': '\ud800',
    'surrogates next to emphasis': '*\ud800* _\udc00_ **\ud800**\ud800\n',
    'surrogate in code span': '`\ud800` ``\udc00``\n',
    'surrogate in link and title': '[\ud800](\udc00 "\ud800")\n',
    'surrogate in label and definition': '[\ud800]\n\n[\ud800]: /u\n',
    'surrogate in heading and table': '# \ud800\n\n| \ud800 | \udc00 |\n|---|---|\n| \ud800 | x |\n',
    'surrogate in fence info': '```\ud800\n\udc00\n```\n',
    'surrogate as indentation neighbour': '\ud800    code\n\n    \udc00\n',
    'surrogate in autolink literal': 'www.\ud800.com \ud800@a.b http://a.b/\ud800\n',
    'valid pair split by emphasis': '\ud83d*\ude00*\n'
  },
  'tabs': {
    'tab-indented code': '\tcode\n\t\tmore\n\n\tx\n',
    'tab after list marker': '-\ta\n-\t\tb\n1.\tc\n',
    'tab after blockquote marker': '>\ta\n>\t\tb\n>\n>\t\tc\n',
    'tab then code in list': '- a\n\n\t\tcode\n\n\tb\n',
    'tab in blockquote in list': '- >\ta\n  >\t\tb\n',
    'tab after heading marker': '#\ta\n##\t\tb\t##\t\n',
    'tab around thematic break': '*\t*\t*\n-\t-\t-\n\t***\n',
    'tab in fence open and close': '```\tjs\tx\n\tcode\n```\t\n\t```\n',
    'tab inside indented fence': '  ```\n\tcode\n  ```\n',
    'tab in table': '|\ta\t|\tb\t|\n|\t-\t|\t-\t|\n|\t1\t|\t2\t|\n',
    'tab in table delimiter': '| a | b |\n|\t:-\t|\t-:\t|\n',
    'tab in link': '[a](\t/u\t"t"\t)\n\n[b]:\t/u\t"t"\t\n\n[b]\n',
    'tab in html': '<a\thref="x"\t>\n\n<div\t>\nx\n</div>\n',
    'tab in code span': '`\ta\t` ` \ta `\n',
    'tab hard break': 'a\t\t\nb\t\n\tc\n',
    'tab continuation line': 'a\n\tb\n\t\tc\n',
    'tab in setext': 'a\nb\n\t=\n\nc\n=\t\n',
    'tab in footnote definition': 'a[^1]\n\n[^1]:\tx\n\n\ty\n\n\t\tz\n',
    'tab in task list': '-\t[ ]\ta\n- [\t] b\n- [x]\tc\n',
    'tab in entity-like and attention': '*\ta*\n*a\t*\n_\ta_\n',
    'tab in autolink literal context': '\twww.a.com\t\thttp://a.b\t\tc@d.e\t\n',
    'tab between container prefixes': '> -\ta\n>\t-\tb\n>\t\t-\tc\n',
    'only tabs between text lines': 'a\n\t\t\t\nb\n',
    'virtual column partial tab': '  \tcode\n   \tcode\n    \tcode\n',
    'tab-indented list continuation': '1.\ta\n\n\tb\n\n\t\tc\n2.\td\n',
    'tab-indented definitions': '\t[a]: b\n  [c]:\td\n',
    'tab in blockquote lazy continuation': '> a\n\tb\n> \tc\n'
  }
}

// Parse-time stress that is too slow for a laptop: only with BIG=1 (CI).
// micromark is superlinear (a mixed document: 400 KB 1.6 s, 800 KB 5.1 s, 1.6 MB 19 s on a fast laptop; at 10 MB it
// ran for 42 minutes and ran out of a 6 GB heap in CI). Full-tree comparison therefore runs at 2 to 3 MB; the 10 MB
// inputs (`huge`) check the fast parser alone: it must finish quickly, not throw, and give the same tree twice.
const MB = 1024 * 1024
const fit = (text, n) => rep(text, Math.ceil(n / text.length)).slice(0, n)
export const big = {
  '3 MB of mixed markdown': () => fit(DOC + '\n', 3 * MB),
  '2 MB of blank and text lines': () => fit('a\n\n', 2 * MB),
  '2 MB CRLF': () => fit(withEol('\r\n') + '\r\n', 2 * MB),
  '2 MB CR': () => fit(withEol('\r') + '\r', 2 * MB),
  '2 MB of tab-indented and list-heavy text': () => fit('-\ta\n\tb\n\n    code\n\n1.\tx\n   - y\n', 2 * MB),
  '500 KB single paragraph line': () => fit('word *em* `c` [l](u) ', 500 * 1024),
  'big table 20k rows': () => '| a | b | c |\n|---|---|---|\n' + rep('| 1 | `2` | *3* |\n', 20000),
  'deep bq 5000': () => rep('> ', 5000) + 'a\n',
  'deep list 3000': () => rep('- ', 3000) + 'a\n'
}
export const huge = {
  '10 MB of mixed markdown': () => fit(DOC + '\n', 10 * MB),
  '10 MB of blank and text lines': () => fit('a\n\n', 10 * MB),
  '10 MB CRLF': () => fit(withEol('\r\n') + '\r\n', 10 * MB),
  '10 MB single line of inline constructs': () => fit('word *em* `c` [l](u) ', 10 * MB),
  '10 MB of one repeated emphasis delimiter run': () => fit('*a ', 10 * MB),
  '10 MB of unmatched brackets': () => fit('[a ', 10 * MB),
  '50k-deep blockquote and list': () => rep('> ', 50000) + rep('- ', 50000) + 'a\n'
}
