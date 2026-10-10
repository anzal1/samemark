# samemark internals: how micromark's behavior was matched

This file is the engineering log of the parser in `src/`: the question it started from, the micromark quirks that had to be
reproduced, and the checks. Question: can a hand-written JS markdown parser produce mdast identical to
mdast-util-from-markdown + micromark-extension-gfm (positions included), much faster?

Setup (development): a corpus of 4,780 distinct README.md files (30.44 MB) collected from node_modules trees on the
author's machine. It is not in this repository; `bench/readme-corpus-manifest.json` lists package, version and sha256 of each
file and `node bench/readme-corpus.mjs` rebuilds it from npm (slow, optional). The public harnesses use pinned docs
repositories, a synthetic corpus and the spec examples instead (`bench/corpora.json`). Reference = fromMarkdown with gfm(), gfmFromMarkdown(). Comparison strips `children`
of paragraph, heading and tableCell in both trees, then exact JSON equality.
Run: `node bench/run.mjs` (corpus + CommonMark / GFM spec + speed), `node bench/heldout.mjs --roots=DIR`
(non-README .md files not used for tuning).

## Iteration log
| # | identical | MB/s (block) | change |
|---|-----------|--------------|--------|
| 1 | 88.33% (4222/4780) | 401 | first end-to-end run; 492 files hit a bug in my port of micromark resolveTable cell flushing (wrong field name) |
| 2 | 98.39% | - | table cells fixed; remaining: html first-line indentation kept in value (33), table head after unmatched containers (11), listItem.spread (8) |
| 3 | 99.87% | - | html start/value include indentation; table head allowed when containers close; late attribution of blank lines to the item that survives the closing line (not a nested list that closes); BOM stripped; whitespace-only indented-code lines with >=4 columns extend the code; table end = delimiter row if no body; strip one trailing EOL from indented code value |
| 4 | 100.00% | ~390 | item end uses micromark "M2" rule (bq-prefix-only lines skipped for items inside a surviving blockquote, tracked as E2 vs E1); list spread derived from the same point |
| 5 | 100.00% corpus, 99.92% held-out | ~355 | NUL to U+FFFD, unclosed fence/html(1-5) end/value quirks (EOL consumed when closed by item continuation failure or EOF outside blockquotes; item end = next sibling prefix end), setext heading start = content start even after definitions, html `</textarea>` end detection, reset all module state per parse (a leak was hiding in spec runs) |

Final: corpus 4780/4780 identical, CommonMark spec examples (652) 651 pass, held-out 10,710/10,719,
block parser ~355-400 MB/s vs micromark+gfm ~3.5 MB/s (~100x).

## How micromark's positions were matched (the non-obvious bits)
- Columns are offset-based, NOT tab-expanded (a tab is 1 column). Tabs only matter for indentation
  decisions (virtual columns); a partially consumed tab leaves virtual spaces in code/html values and
  the token starts after the tab char.
- Container end = start of the earliest EOL in the trailing run of {EOL, whitespace, list indent}
  tokens (subtokenize `_container` fix). Blockquote-prefix-only lines are real tokens for blockquotes
  and lists (E1) but skipped for list items that are closed by a following item or survive (E2).
- Unclosed fenced code: EOL is part of the code when the flow is closed by item-continuation failure,
  a new container starting, or EOF with no blockquote open; otherwise code ends at last line end.
  In that case a non-last list item ends at the END OF THE NEXT ITEM'S PREFIX (mdast-util quirk).
- Paragraph/heading/definition/thematic/heading ends include trailing whitespace.
- Table cells: start at the preceding pipe (or row start), end at next pipe start; last cell includes
  a trailing pipe and runs to end of row. Table end = last row, or delimiter row if no body rows.
  Header row accepts a single no-pipe cell if the delimiter row has a colon (micromark quirk, ported).
- Task list item paragraph start moves +1 after `[x]` only when the head text node is longer than
  one char: this depends on inline parsing (see below).
- Footnote definitions are containers (indent 4 or blank continue); they can interrupt paragraphs.

## Optional extensions (frontmatter, math)
- `parse(src, {frontmatter: normalizeMatters(options), math: {single}})`; both default off (plain GFM).
- Frontmatter is a `concrete` flow construct at line 1 column 1 only: open fence line (fence + spaces / tabs + EOL),
  every following line is content, a line that is the close fence plus optional whitespace closes it, end of input
  before that = no frontmatter. Node `{type, value, position}`; value = the lines between, joined with their raw
  EOLs. QUIRK: while the open fence is still waiting for its close (i.e. forever when it never closes), micromark's
  document tokenizer treats every later line as concrete content: no quote, list item or footnote definition can
  start on any later line (`---\n- a\n> b` is a thematic break then ONE paragraph), and the table delimiter check
  no longer rejects list-looking rows (`noContainers`).
- Math: `$$` flow math is the fenced-code machinery with `$`: fence >= 2, rest of the line = `meta` (no `$` allowed,
  raw incl. trailing whitespace, null if empty), node `{type: 'math', meta, value, data.hChildren}`. Inline math is
  the code-span machinery (same padding rule, same "run of exactly the opening length" closer, same escape
  / previous-char rule) with node `{type: 'inlineMath', value, data}`; `singleDollarTextMath: false` makes a lone `$` data.
- Construct names for fingerprinting: the frontmatter constructs have NO `name`; recognise them by the `flow` hook
  (codes 45 / 43 or the custom open char) with `concrete: true` and `tokenize.name === 'tokenizeFrontmatter'`, and
  by the mdast `enter` / `exit` keys `yaml`, `toml`, `yamlValue`, `tomlValue` (custom types for custom matters).
  Math: `flow: {36: {name: 'mathFlow', concrete: true}}`, `text: {36: {name: 'mathText'}}`; mdast keys `mathFlow`,
  `mathFlowFence`, `mathFlowFenceMeta`, `mathFlowValue`, `mathText`, `mathTextData`. `singleDollarTextMath` is a
  closure: probe it with `$a$` and `$$a$$`.

## Streaming parser (src/stream.js)

`createStreamParser({frontmatter, math})` returns `{push(chunk), end(), reset()}`. After every push the returned tree equals `parse(everything pushed so far, options)`, positions included.

- Safe point: a complete top-level blank line with nothing open (no container, fence, html block, indented code, paragraph or table). Setext underlines, table delimiter rows, lazy continuation and list continuation all need adjacency, so text before the last safe point is final. Each push re-parses only the text after it, then shifts positions by that offset and line.
- Finished top-level nodes are reused as the same objects. The one exception is a later link or footnote definition: the inline parser records which definition ids each paragraph looked up (misses and hits), and when one of those ids appears or vanishes the paragraph is rebuilt, copy on write along its path.
- A trailing lone CR is never treated as a complete line ending (the next chunk may start with LF). A leading BOM and NUL replacement are handled once at the stream start.
- Cost: O(new text + unfinished tail). One very large unfinished block (a huge open fenced code block, a list with no blank line in it, a single enormous paragraph) is re-parsed per push, so it costs O(its size) per push. LLM answers close blocks with blank lines, so the tail stays small.
- Verification: `bench/stream-diff.mjs` replays corpus files and fuzz strings in 1-char, random, token-like, whole-line and split-line chunkings and compares with a full parse after every push (`--mode=corpus|fuzz|regress`, `--opts=none|fm|math|all`); `bench/stream-bench.mjs` times full re-parse per push against the stream parser at 10k, 30k and 100k characters.
- CI (the last run on the private development repository): 18 stream jobs, 465,378 documents, 48,196,453 pushes, each compared with a full parse, 0 failing (corpus none/fm/all, fuzz base/rich/links/fm/math/all). Benchmark, 12 chars per push, full re-parse per push vs stream total: 10k chars 422 ms vs 66 ms (6.4x), 30k 981 ms vs 54 ms (18.2x), 100k 9,232 ms vs 133 ms (69.4x; p50 per push 1.10 ms vs 0.009 ms).

## Known gaps
See KNOWN_GAPS.md (minimal repros, one file the README links to). Held-out set: all 10,893 local non-README
markdown files identical (run in batches: `node bench/heldout.mjs --roots=DIR --list=FILE --from=0 --to=900`). That set
is specific to the author's machine and is not published.

## CI measurements made during development (runner ubuntu-latest, 2 cores, README corpus)
- corpus 4780/4780 full-tree identical, CommonMark spec 652/652 (with the deterministic hash sample for local
  iteration: `node bench/run.mjs --sample=24`)
- full parse 43-78 MB/s vs micromark+gfm 1.0-1.9 MB/s (39-46x) on the runner; 119 MB/s vs 3.8 MB/s locally
- differential fuzz (30 jobs): 25.5M exhaustive strings (17-char alphabet, length <= 6), 1.5M with definitions
  appended, 6M random (long `*`/`_` runs weighted), 2.4M random over a rich token set, 1M one-char mutations of
  corpus paragraphs, 1M CommonMark spec crossovers: 0 failing at commit "scaling guard: median pairwise slope"
- scaling guard: 70 cases, each size in its own process with a 256 MB semi-space (no GC knees), best of two,
  lower-median pairwise log-log slope <= 1.5 (checked against a synthetic quadratic: slope 2.04)
