# Known gaps

samemark is checked against `mdast-util-from-markdown` + `micromark-extension-gfm` + `mdast-util-gfm` (the pinned
versions in `package.json`) on full trees, positions included. Evidence at the time of writing: 4,780 / 4,780
corpus READMEs, 652 / 652 CommonMark spec examples, 10,893 / 10,893 held-out non-README markdown files, and
tens of millions of differential fuzz cases (see `NOTES.md` for the exact CI numbers). This file lists
every divergence that is known to remain, with a minimal repro for each one. All of them are block-level
corners around footnote definitions and lists; none was found in any real document. Each repro below is also
in `bench/known-gaps.json`, so the fuzzer reports (but does not fail on) these shapes.

## 1. `spread` of a list item that contains a footnote definition

| input | node | micromark | samemark |
|---|---|---|---|
| `[^1]:*\n\n\t-` | `listItem.spread` of the `*` item inside the footnote definition | `true` | `false` |
| `[^1]:-\n\n\t[^1]:` | `listItem.spread` of the `-` item | `true` | `false` |
| `>- [^1]:\n>` | `listItem.spread` of the item that holds the definition, followed by a `>`-only line | `true` | `false` |

Same family with other labels / shapes: `>- [^a]:\n>`, `-\n  [^a]:\n\t  (` (list `spread` true in micromark) and, without a
footnote, `>>* 1.\n>>\n>>   o` (item `spread` false in micromark, true in samemark: an empty nested item followed by a
blockquote-prefix-only line and indented content), plus `- - \n\t[x]\t#` (micromark does not treat `[x]` as a task
check when one tab is shared between two item indents; samemark sets `checked`).

Cause: `mdast-util-from-markdown` derives `spread` from `lineEndingBlank` events. Inside a footnote definition the
footnote prefix events reset its "at marker" state, which changes which blank line counts. samemark computes
`spread` from blank lines between children and has no rule for this.

## 2. Empirical end-position rules (exact on every test input so far, but not derived from micromark's algorithm)

micromark places container exits using the `_container` fix in `micromark-util-subtokenize` and the item
end logic in `mdast-util-from-markdown` (`prepareList`). samemark reproduces the resulting positions with a
small set of rules found by fuzzing instead of porting those event passes:

* a container closed by a new container on the same line, after a blockquote or footnote prefix, exits
  right after that prefix (`>*\n>>`, `>- a\n>>b`, `[^5]:>\n    2.`);
* an item that is empty or ends in a nested list / blockquote exits there too, depending on the prefix kind
  (`>* *\n>`, `>- >\n>`, `[^1]:*\n    2.`) and a footnote-prefix sibling item ends at the end of the next
  item's prefix (`[^1]:- a\n    - b`);
* a list that ends in two or more blockquote-prefix-only lines is `spread` (`>1.\n>\n>`), a closing new
  container counts one more line, a blank line with its own EOL one less (`>>1.\n>>\n>\n`);
* unclosed fences / html blocks inside containers (`- ```\n  x\n\n> b`, `- ><!--\n  -`).

Every shape above is in `bench/regressions.json` and passes. Shapes outside what the fuzzer reached (deeply
nested mixtures of empty items, quotes and footnote definitions ending a document) may still differ in the
`end` position of a container, never in the content or structure of leaf blocks.

## 3. Fenced code / math value with lone-CR line endings

`" ~~~\r \n\n"` (an indented fence, a lone `\r` as first line ending, then a whitespace-only line shorter than the
fence indent): micromark's value regex `/^(\r?\n|\r)|(\r?\n|\r)$/g` sees `\r` followed by an empty line's `\n` as
one CRLF and strips both, samemark builds the value from lines and keeps one `\n` (`""` vs `"\n"`). Only files that
use bare `\r` line endings can hit it.

## 4. Not a divergence, but different behaviour

* Nesting depth: micromark throws `RangeError: Maximum call stack size exceeded` for roughly 10,000 nested
  blockquotes or list items on one line. samemark parses them (`test/depth.test.mjs`).
* Optional extensions: `remark-frontmatter` (yaml / toml / custom `marker` or `fence` matters, positions and an
  unclosed fence's effect on later containers included) and `remark-math` (`$` / `$$` text math, `$$` flow math,
  `singleDollarTextMath`) are implemented natively (`parse(src, {frontmatter, math})`). Matters with
  `anywhere: true` are not: `frontmatterSupported()` returns false and the plugin must fall back.
* samemark only implements the stock GFM extension set otherwise. The remark plugin falls back to the real
  `remark-parse` for anything else (extra micromark / mdast extensions, `gfm({singleTilde: false})`, no GFM).

## 4. Outside the identity claim, by design (packaging level)

* Anything beyond stock GFM (`remark-frontmatter`, `remark-math`, `remark-directive`, MDX, `singleTilde: false`, any
  micromark extension that adds a construct or uses `disable`) is detected and handed to the real parser, so the
  result is micromark's own, at micromark's speed. `strict: true` turns that into an error. See the compatibility
  table in the README.
* `parse()` and the plugin accept `string`, `Uint8Array` (decoded as UTF-8) and objects with `toString()`. Only
  strings are compared to `fromMarkdown` in the test suite.
* In browsers a bundler picks the `browser` export of `decode-named-character-reference`, which decodes named
  character references through the DOM instead of a table. micromark does exactly the same in that setting, so
  both parsers agree, but the answer for an unusual reference then depends on the browser. Edge runtimes and Node
  use the table.

## 5. Edge inputs checked in the packaging pass (all identical, none found a parser bug)

CRLF, lone CR, mixed line endings, BOM (alone, repeated, mid-text), NUL (replaced by U+FFFD) in every construct,
empty and whitespace-only input, 50k-character lines, nesting 1000 deep, astral characters and combining marks next
to emphasis markers, lone surrogates, tabs in every construct. The list is `test/edge-cases.mjs`; 10 MB inputs run
in CI only (`BIG=1`). A new failing input goes in `test/known-gaps.json` (each entry runs as a `todo` test) and in
a table here.
