# samemark

The same mdast as remark-parse, much faster.

samemark is a markdown parser that returns the same mdast tree as `mdast-util-from-markdown` with GFM (what
`remark-parse` + `remark-gfm` produce), positions included, and falls back to that real parser for anything it
does not reproduce exactly.

[micromark](https://github.com/micromark/micromark) by Titus Wormer defines the behavior; this parser matches it and
falls back to it. Its test suite and its output are the specification.

**How it was made.** AI agents wrote most of the code. Every change is checked against micromark's own output: the
full tree must be equal, node by node, on thousands of real documents, the CommonMark spec examples, and tens of
millions of generated inputs. Nothing here relies on trust in the author or the model; the checks are in this
repository and the commands to run them are below.

## What you get

<!-- bench:headline -->
In a real unified pipeline (markdown to HTML with `remark-gfm`, `remark-rehype`, `rehype-stringify`) the whole run is
about **10x faster** with samemark as the parser: 7.2x to 10.8x across six inputs on a GitHub Actions runner (Node 24,
median of 7 rounds, identical HTML on every file); 7.0x to 10.4x with `remark-frontmatter` and `remark-math` added.
Parsing alone is 22x to 39x faster; the rest of the pipeline is unchanged, which is why the end-to-end number is smaller.
Rendering a long chat answer with react-markdown, as a streaming chat UI does on every token, takes 6.5x to 7.3x less
time per update in Node, and in Chromium with the CPU throttled to 4x to 6x slower (a phone proxy) a 30,000 character
message re-renders in 46 ms instead of 263 ms at 6x. Building a 239-page Astro site took 36.1 s with `remark-parse` and
27.8 s with samemark (23% less). Numbers move a little between runners and runs; the tables below come from one CI run
and everything is reproducible with `npm run bench`. Details and method: [Benchmarks](#benchmarks).
<!-- /bench:headline -->

- `parse(source)` returns an mdast `Root` equal to `fromMarkdown(source, {extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()]})`.
- `remarkParseFast` is a drop-in for `remark-parse` in a unified processor.
- `remark-gfm`, `remark-frontmatter` (yaml, toml or both) and `remark-math` (with or without `singleDollarTextMath`)
  are implemented natively, alone or together. Anything else (`remark-directive`, MDX, custom frontmatter fences,
  other micromark extensions) is detected and given to the real parser. You get micromark's answer, at micromark's
  speed.
- No micromark at parse time. The fast path imports six small pure helper packages (four `micromark-util-*`
  packages plus `ccount` and `decode-named-character-reference`) and nothing else. `mdast-util-from-markdown` is
  only needed for the fallback, as an optional peer dependency.

## Install

```sh
npm install samemark
# for the fallback (recommended; the main entry imports it):
npm install mdast-util-from-markdown unified remark-gfm
```

Node 18 or newer, or any runtime with ES2020 and `TextDecoder` (browsers, Deno, Bun, edge runtimes).

## Usage

With unified, replace `remark-parse`:

```js
import {unified} from 'unified'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import remarkParseFast from 'samemark'

const file = await unified()
  .use(remarkParseFast) // instead of remark-parse
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify)
  .process('# Hello *world*')
```

Inside a framework that already installs `remark-parse` (Astro, MDX, Next.js plugins), add it to `remarkPlugins`;
it replaces the parser after `remark-gfm` has registered, which is the order it needs:

```js
// astro.config.mjs
import remarkParseFast from 'samemark'
export default {markdown: {remarkPlugins: [remarkParseFast]}}
```

With react-markdown (it builds a unified processor on every render with `remark-parse` first, so a plugin that sets the
parser takes over; verified by the benchmark below):

```jsx
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParseFast from 'samemark'

const plugins = [remarkParseFast, remarkGfm] // define once, outside the component

export const Answer = ({text}) => <Markdown remarkPlugins={plugins}>{text}</Markdown>
```

Chat apps re-render the whole message on every streamed token, so the parser runs again over a growing string each
time; see the react-markdown numbers in [Benchmarks](#benchmarks).

Without a processor:

```js
import {parse} from 'samemark'
const tree = parse('# Hello *world*') // mdast Root
```

### Entries

| Entry | Fallback | Imports |
|---|---|---|
| `samemark` | the real parser, `mdast-util-from-markdown` (optional peer) | needs `mdast-util-from-markdown` installed |
| `samemark/stream` | none; incremental parser for streamed text, stock GFM with optional frontmatter and math | the six helper packages; also CommonJS |
| `samemark/core` | none: throws on unsupported extensions, unless `remark-parse` was set up before the plugin (it then takes over) or `{fallback}` is passed | only the six helper packages; also `require('samemark/core')` from CommonJS |

The main entry also runs a one-time check per processor: three small documents are parsed by both parsers with the
processor's own extensions; any difference sends that processor to the fallback (reason: "self-check ... failed").
That guards against a micromark release that changes behavior. It is a tripwire, not a proof.

### Options

Both `parse(source, options)` and `remarkParseFast(options)` take:

| Option | Meaning |
|---|---|
| `strict` | Throw instead of falling back (also when the fast parser itself throws). Default `false`. |
| `onFallback(reason)` | Called with a reason string for every document parsed by the fallback. |
| `warn` | One `console.warn` per distinct fallback reason. |
| `fallback(text, ctx)` | Parser to use instead of the default fallback. `ctx` has `extensions`, `mdastExtensions`, `settings`. |

`parse` additionally accepts `extensions` and `mdastExtensions` (the arrays you would give `fromMarkdown`). Left out,
stock GFM is assumed. `source` may be a string, a `Uint8Array` (UTF-8) or an object with `toString()`.

Nobody should find out about a fallback in a profiler. `stats` is exported by both entries:

```js
import {stats, check} from 'samemark'
stats // {fast: 120, fallback: 0, lastFallbackReason: null}
check(micromarkExtensions, fromMarkdownExtensions) // null when the fast path is exact, else the reason
```

## Streaming for chat UIs

Chat UIs re-parse the whole message every time a token arrives. With samemark as the parser that re-parse is 3x to 7x
cheaper depending on the runtime, with identical output (react-markdown numbers in [Benchmarks](#benchmarks)).
`samemark/stream` removes the re-parse: it is incremental, and it stays exactly identical to parsing the whole text.

```js
import {createStreamParser} from 'samemark/stream'

const stream = createStreamParser()          // options: {frontmatter, math}, same meaning as remark-frontmatter / remark-math
for await (const chunk of tokens) {
  const tree = stream.push(chunk)            // mdast Root, equal to parse(everything pushed so far), positions included
  render(tree)
}
stream.end()                                 // final tree; stream.reset() starts a new message
```

- After every push the tree equals what `parse()` returns for all text so far, which equals micromark's tree. Chunks
  can split anything: a token, a fence, a table row, a link.
- Blocks that can no longer change keep their object identity from push to push (an unfinished tail is re-parsed, the
  rest is reused), so `React.memo` keyed on the node skips them. The cost of a push is the new text plus the unfinished
  tail, not the whole message.
- A later reference or footnote definition can change how an earlier block resolves; the affected blocks are rebuilt
  as new objects, so identity changes exactly when the content can have changed.
- Supports stock GFM, optionally with frontmatter and math. For other extensions parse the whole message with
  the main entry. Also `require('samemark/stream')` from CommonJS.

A React integration lives in [`examples/react-chat/StreamMarkdown.jsx`](examples/react-chat/StreamMarkdown.jsx): a
`useMarkdownStream()` hook and a `<StreamMarkdown tree>` component that renders the mdast with `mdast-util-to-hast` and
`hast-util-to-jsx-runtime`, one memoised block per top-level node, applying the same URL sanitising and raw HTML
handling as react-markdown. Its HTML equals react-markdown's for the whole message (`test/stream.test.mjs`, and the DOM
comparison in the Chromium benchmark below).

```jsx
import {StreamMarkdown, useMarkdownStream} from './StreamMarkdown.jsx'

function Answer({tokens}) {                  // tokens: an async iterable of strings
  const {tree, push, reset} = useMarkdownStream()
  useEffect(() => {
    reset()
    ;(async () => { for await (const chunk of tokens) push(chunk) })()
  }, [tokens])
  return <StreamMarkdown tree={tree} />
}
```

### Streaming cost

Parser only, from `node bench/stream-bench.mjs` in CI (ubuntu-latest, 12 characters per push, a generated LLM-style
answer): total time to push the whole answer, a full re-parse per push against `createStreamParser`.

| Answer length | Full re-parse per push | `samemark/stream` | Speedup |
|---|---|---|---|
| 10,451 characters | 422 ms | 66 ms | 6.4x |
| 30,416 characters | 981 ms | 54 ms | 18.2x |
| 100,193 characters | 9,232 ms | 133 ms | 69.4x |

Identity of that parser, in CI: 48,196,453 pushes over 465,378 documents (corpus replays, fuzz strings, 1-character,
random, token-like and whole-line chunkings, with and without frontmatter and math), each tree compared with a full
parse; 0 failing.

React render included (DOM commit, memoised blocks):

<!-- stream-bench:start -->
Interim numbers from a laptop (Apple M5 Max, Node 24, React 19 production build, jsdom as the DOM; reproduce with
`npm run bench:stream`, about three seconds). The Chromium version with 4x and 6x CPU throttling runs in the `bench`
workflow (`bench/perf/reactmd-browser.mjs`) and replaces these when its numbers are in.

One message of 30,000 characters streamed 200 characters per push into a jsdom node (React production, flushSync per push).

| Variant | Pushes | Total | Per push p50 | p95 | worst | Same DOM as (a) |
|---|---|---|---|---|---|---|
| (a) react-markdown, whole message per push | 150 | 1.15 s | 7.7 ms | 13 ms | 14 ms | 31/31 |
| (b) react-markdown + samemark | 150 | 274 ms (**4.2x** less) | 1.8 ms | 2.7 ms | 15 ms | 31/31 |
| (c) stream parser + memoised blocks | 150 | 42 ms (**27.4x** less) | 0.2 ms | 0.7 ms | 4.1 ms | 31/31 |

(a) is what a chat UI does today: react-markdown re-parses and re-renders the whole message on every push. (b) swaps
the parser only. (c) is `examples/react-chat`. All three produce the same DOM, compared after every fifth push and at the end.
<!-- stream-bench:end -->

## Compatibility

Exact statement. The fast path is verified, and only verified, against these pinned versions
(`package.json` `devDependencies`, installed by `npm ci`):

| Package | Version |
|---|---|
| micromark | 4.0.3 |
| micromark-extension-gfm | 3.0.0 |
| mdast-util-gfm | 3.1.0 |
| mdast-util-from-markdown | 2.1.0 |
| remark-parse | 11.0.0 |
| remark-gfm | 4.0.1 |
| unified | 11.0.5 |

Other versions are not claimed. A newer micromark that changes output is caught by the main entry's self-check
(it then uses the fallback), and by `npm test` in this repository, which fails if the stock GFM construct set
changes (`node scripts/gen-signature.mjs --check`).

What counts as supported is decided by construct names, not by function source, so minified bundles of
micromark keep the fast path (tested with an esbuild `--minify` bundle that includes the frontmatter and math
extensions). Settings that hide in closures (`singleTilde: false`, `singleDollarTextMath: false`, which fences a
frontmatter matter uses, `anywhere: true`) are read by running the real tokenizers on probe strings; the result is
compared with what the stock configuration does. Any unknown construct, any `disable` entry, a custom or `anywhere`
frontmatter matter, or a missing GFM piece means fallback.

### Which setups take the fast path

Generated by `node scripts/compat-table.mjs` from the same cases `npm test` asserts (each fast row is also compared with `remark-parse` on a document that exercises it):

<!-- compat:start -->
| Setup | Path | Reported reason |
|---|---|---|
| remark-gfm | **fast** |  |
| remark-gfm twice | **fast** |  |
| remark-gfm with `tablePipeAlign` / `tableCellPadding` (serialisation options only) | **fast** |  |
| remark-gfm + remark-breaks (tree transform only) | **fast** |  |
| remark-gfm + remark-smartypants (tree transform only) | **fast** |  |
| remark-gfm with `singleTilde: false` | fallback (real parser) | `strikethrough is not the stock GFM one (singleTilde: false or unknown tokenizer)` |
| remark-gfm + remark-frontmatter (yaml) | **fast** |  |
| remark-gfm + remark-frontmatter `['yaml', 'toml']` | **fast** |  |
| remark-gfm + remark-frontmatter `'toml'` | **fast** |  |
| remark-gfm + remark-frontmatter with a custom `fence` (same type, other fence) | fallback (real parser) | `frontmatter fences differ from the stock yaml matters (custom or `anywhere` matter)` |
| remark-gfm + remark-frontmatter with a custom matter type | fallback (real parser) | `micromark extension not in the supported set (GFM, frontmatter, math): flow\|unnamed construct at code 60 ('<')` |
| remark-gfm + remark-frontmatter with `anywhere: true` | fallback (real parser) | `frontmatter fences differ from the stock yaml matters (custom or `anywhere` matter)` |
| remark-gfm + remark-math | **fast** |  |
| remark-gfm + remark-math with `singleDollarTextMath: false` | **fast** |  |
| remark-gfm + remark-frontmatter + remark-math | **fast** |  |
| remark-frontmatter + remark-math without remark-gfm | fallback (real parser) | `GFM is not fully enabled (missing micromark construct attentionMarkers\|126)` |
| remark-gfm + remark-directive | fallback (real parser) | `micromark extension not in the supported set (GFM, frontmatter, math): flow\|unnamed construct at code 58 (':')` |
| remark-gfm + remark-frontmatter + remark-directive | fallback (real parser) | `micromark extension not in the supported set (GFM, frontmatter, math): flow\|unnamed construct at code 45 ('-')` |
| remark-mdx (MDX) | fallback (real parser) | `GFM is not fully enabled (missing micromark construct attentionMarkers\|126)` |
| remark-gfm + remark-mdx | fallback (real parser) | `micromark extension not in the supported set (GFM, frontmatter, math): disable\|{"null":["autolink","codeIndented","htmlFlow","htmlText"]}` |
| no remark-gfm (CommonMark only) | fallback (real parser) | `no GFM extensions (CommonMark-only parsing needs the fallback)` |
| unknown micromark construct | fallback (real parser) | `micromark extension not in the supported set (GFM, frontmatter, math): text\|atSign` |
| micromark `disable` entry | fallback (real parser) | `micromark extension not in the supported set (GFM, frontmatter, math): disable\|{"null":["codeIndented"]}` |
<!-- compat:end -->

Frameworks. **Astro** (plain markdown, `remark-gfm` default): fast. **Starlight** adds `remark-directive` for asides,
so it falls back and gains nothing. **Docusaurus** and **MDX** compile through `micromark-extension-mdxjs`: fallback.
`@mdx-js/mdx` with `format: 'md'` and `remark-gfm`: fast.

## How identity is verified

"Identical" means `JSON`-equal trees including every `position`, not "looks the same" (`firstDiff` in
`bench/common.mjs`; `undefined` fields are treated as absent).

| Check | What | Command |
|---|---|---|
| Spec | all 652 CommonMark 0.31.2 examples, the 672 GFM spec examples and the 30 GFM extension examples, full tree compared | `npm run check` |
| Docs and synthetic corpora | Node.js API docs and changelog, Rust book, Vite docs, a React changelog (pinned commits, fetched in CI, `bench/corpora.json`) and 240 generated documents (`bench/synthetic.mjs`), full tree compared | `npm run corpus && npm run check` |
| README corpus (development) | 4,780 README.md files of npm packages (30 MB) collected on the author's machine, full tree compared (all identical at the last run). 4,648 of them are in `bench/readme-corpus-manifest.json` (package, version, sha256) and can be rebuilt from npm, slowly | `node bench/readme-corpus.mjs && node bench/run.mjs --readme --nospeed` |
| CommonMark spec | all 652 examples of spec 0.31.2 | `npm run check` |
| Held-out | 10,893 non-README markdown files from the author's machine, never used while writing the parser (all identical at the last run). The file list is machine specific, so others cannot repeat this exact set; pass your own list | `node bench/heldout.mjs --roots=DIR` |
| Differential fuzzing | exhaustive strings (17 characters, length up to 6), random, token-biased, mutations of corpus paragraphs, spec crossovers | `node bench/fuzz.mjs --mode=exhaustive --maxlen=5 --shard=0/64` (the full matrix, about 60M cases in 60 jobs, is `.github/workflows/full.yml`, weekly or by hand; `ci.yml` runs about 2M cases on every push) |
| Frontmatter and math | the corpus and spec examples with yaml / toml / custom frontmatter prepended (CRLF, unclosed fences, not at the start) and with math enabled, plus extension-aware fuzzing | `node bench/frontmatter.mjs --sample=24` |
| Streaming | `samemark/stream` replays documents in random chunk sizes; the tree after every push must equal a full parse, and micromark's at checkpoints (corpus, spec examples, edge inputs, definitions arriving late) | `node bench/stream-diff.mjs --mode=regress`, `node --test test/stream.test.mjs` |
| Regressions | every input that ever failed | `node bench/fuzz.mjs --mode=regress` |
| Edge inputs | CRLF, CR, BOM, NUL, lone surrogates, empty, 50k-character lines, deep nesting, unicode, tabs; 10 MB inputs in CI | `node --test test/edge.test.mjs`; `BIG=1` for 10 MB |
| Packaging | minified bundle keeps the fast path, edge-runtime VM, Chromium, Deno, Node 18 to 24, packed tarball in an empty project | `npm test`; `ci.yml` (Node 18 to 24, packed tarball), `full.yml` (Deno, Chromium, 10 MB inputs) |

Third-party text is never committed. The docs corpora are fetched at pinned commits (licences: MIT for Node.js, Vite and
React, MIT or Apache-2.0 for the Rust book, BSD-2-Clause code with CC-BY-SA spec text for the GFM spec examples), the
README corpus is rebuilt from npm by sha256 manifest, and the synthetic corpus is generated from a seed.

## Known differences

On the tested set (spec examples, corpora, held-out, edge inputs) there are none. Differential fuzzing did find
shapes that differ, all block-level corners around footnote definitions and lists; they are listed with minimal
inputs in [KNOWN_GAPS.md](KNOWN_GAPS.md) and none occurs in a real document so far. What is not covered by the
identity claim: non-GFM extensions (they fall back, by design), non-string input types, and pipelines other than the
ones in the compatibility table.

Behavior that is different on purpose: micromark throws a `RangeError` on roughly 10,000 levels of nesting; samemark
parses it. Large single inputs: micromark's time grows faster than linearly with document size (a mixed document took
1.6 s at 400 KB, 5.1 s at 800 KB and 19 s at 1.6 MB on a fast laptop; one 500 KB paragraph of inline markup takes 16 s;
a 10 MB comparison ran 42 minutes and exhausted a 6 GB heap), while samemark parsed a 10 MB mixed document in about
0.4 s. That is why the full-tree comparison in the edge tests stops at 2 to 3 MB and the 10 MB cases only check that
samemark finishes and does not throw.

## Benchmarks

**Which numbers come from which input.** The tables below were produced by the `bench` workflow (and the parser-level
stream benchmark by `bench/stream-bench.mjs`) while the project lived in a private repository. Rows named
"README corpus" ran on the 4,780-file development corpus of npm package READMEs (a 1 in 4 or 1 in 16 sample for the
slower tests; 4,648 of the files are rebuildable from `bench/readme-corpus-manifest.json`). Rows named after a
repository (`node-api-docs`, `rust-book`, `vite-docs`, `node-changelog-v22`, `react-changelog`) ran on the pinned
commits in `bench/corpora.json`; anyone can fetch exactly those with `npm run corpus`. The react-markdown tables use
the generated chat-style answer (`bench/perf/chat-text.mjs`), the Astro site uses the three docs sets, and
`npm run bench` on a fresh checkout measures the pinned docs sets plus the synthetic corpus (and the README corpus
with `--readme` once it is rebuilt). Runner CPUs differ between jobs and runs, so compare the ratios within a table, not
absolute times across tables.

<!-- bench:start -->

Environment: Node v24.21.0, GitHub Actions ubuntu24 X64 (github-hosted), Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz x2, linux x64. Each cell is the median of 7 rounds after one warm-up round, one fresh process per cell.

### End to end: markdown to HTML with unified

`unified().use(parser).use(remarkGfm).use(remarkRehype).use(rehypeStringify)`, with `remark-parse` or with samemark as the parser. Output HTML is compared file by file.

| Input | Files | Size | remark-parse | samemark | Speedup | Parse share before | Parse share after | Identical HTML |
|---|---|---|---|---|---|---|---|---|
| README corpus (1 in 4 sample) | 1165 | 7.50 MB | 8.46 s | 785 ms | **10.8x** | 91% | 30% | 1165/1165 |
| react-changelog | 1 | 0.30 MB | 604 ms | 84 ms | **7.2x** | 91% | 26% | 1/1 |
| node-api-docs | 70 | 4.75 MB | 5.72 s | 534 ms | **10.7x** | 93% | 32% | 70/70 |
| node-changelog-v22 | 1 | 0.88 MB | 1.57 s | 190 ms | **8.3x** | 90% | 21% | 1/1 |
| rust-book | 112 | 1.22 MB | 1.22 s | 141 ms | **8.7x** | 93% | 39% | 112/112 |
| vite-docs | 57 | 0.56 MB | 703 ms | 84 ms | **8.4x** | 92% | 28% | 57/57 |

Content pipeline, as a docs or blog site runs it: `remark-gfm`, `remark-frontmatter` (yaml) and `remark-math` before `remark-rehype`. `vite-docs` has real frontmatter in every page; the README sample gets a generated block so every file has one. Both sides are compared on the HTML.

| Input | Files | Size | remark-parse | samemark | Speedup | Identical HTML | samemark path |
|---|---|---|---|---|---|---|---|
| README corpus (1 in 4 sample) with a synthetic frontmatter block added | 1165 | 7.60 MB | 8.50 s | 816 ms | **10.4x** | 1165/1165 | fast |
| react-changelog | 1 | 0.30 MB | 635 ms | 91 ms | **7.0x** | 1/1 | fast |
| vite-docs | 57 | 0.56 MB | 688 ms | 85 ms | **8.1x** | 57/57 | fast |

For context, other converters on the same input (different pipeline and output: HTML strings, no mdast, not drop-in replacements):

| Input | markdown-it `render` (HTML) | marked `parse` (HTML) |
|---|---|---|
| README corpus (1 in 4 sample) | 796 ms | 687 ms |
| react-changelog | 84 ms | 55 ms |
| node-api-docs | 562 ms | 452 ms |
| node-changelog-v22 | 220 ms | 146 ms |
| rust-book | 129 ms | 111 ms |
| vite-docs | 86 ms | 63 ms |


Environment: Node v24.21.0, GitHub Actions ubuntu24 X64 (github-hosted), AMD EPYC 7763 64-Core Processor x2, linux x64. Each cell is the median of 7 rounds after one warm-up round, one fresh process per cell.

### react-markdown (desktop, Node, `renderToStaticMarkup`, React production build)

react-markdown 10.1.0 builds a new unified processor on every render (`unified().use(remarkParse).use(remarkPlugins)...`), so `remarkPlugins={[remarkParseFast, remarkGfm]}` replaces its parser on every render. The input is a synthetic chat-style answer (headings, lists, code, tables, links; `bench/perf/chat-text.mjs`). Output HTML is compared at 120 prefix lengths, partial constructs included: 120/120 identical. samemark path: 6148 fast, 0 fallback.

One update at a fixed message length (this is also the cost of rendering a finished long answer):

| Message length | react-markdown default | with samemark | Speedup |
|---|---|---|---|
| 10,000 characters | 52 ms | 8 ms | **6.5x** |
| 30,000 characters | 122 ms | 17 ms | **7.3x** |

Streaming simulation: the message grows by a few characters at a time and the whole message is re-rendered after each step, as chat apps do:

| Stream | Updates | default: total / mean / worst update | samemark: total / mean / worst update | Speedup |
|---|---|---|---|---|
| to 10,000 characters, 20 per step | 500 | 4.07 s / 8 ms / 30 ms | 736 ms / 1 ms / 5 ms | **5.5x** |
| to 30,000 characters, 20 per step | 1500 | 27.01 s / 18 ms / 43 ms | 5.35 s / 4 ms / 11 ms | **5.1x** |


### react-markdown in Chromium, CPU throttled as a phone proxy

Chromium 156.0.8078.4, react-markdown 10.1.0 production bundle, `renderToStaticMarkup` in the page. CPU throttling uses DevTools `Emulation.setCPUThrottlingRate` (4x and 6x slowdown of the main thread). It is a proxy for a slower device, not a measurement of one. Same chat-style input as the desktop table; streaming steps are 100 characters here to keep the throttled runs short.

| CPU | Update at 10,000 characters: default / samemark | Update at 30,000 characters: default / samemark | Stream to 10,000: mean update default / samemark | Stream to 30,000: mean update default / samemark | Identical HTML |
|---|---|---|---|---|---|
| no throttling | 12 ms / 3.5 ms (**3.3x**) | 32 ms / 12 ms (**2.7x**) | 6.0 ms / 2.3 ms (**2.6x**) | 17 ms / 5.9 ms (**2.8x**) | 60/60 |
| 4x slower | 58 ms / 12 ms (**4.8x**) | 175 ms / 30 ms (**5.8x**) | 30 ms / 5.9 ms (**5.1x**) | 86 ms / 16 ms (**5.5x**) | 60/60 |
| 6x slower | 90 ms / 17 ms (**5.3x**) | 263 ms / 46 ms (**5.7x**) | 46 ms / 8.7 ms (**5.3x**) | 132 ms / 23 ms (**5.6x**) | 60/60 |


Environment: Node v24.21.0, GitHub Actions ubuntu24 X64 (github-hosted), AMD EPYC 7763 64-Core Processor x2, linux x64. Each cell is the median of 7 rounds after one warm-up round, one fresh process per cell.

### Parse only

Same mdast on both sides (`mdast-util-from-markdown` with `micromark-extension-gfm` and `mdast-util-gfm`, the reference). "Identical" counts files whose full tree, positions included, is equal.

| Input | Files | Size | mdast-util-from-markdown + GFM | samemark | Speedup | Identical |
|---|---|---|---|---|---|---|
| README corpus | 4780 | 30.44 MB | 25.09 s | 703 ms | **35.7x** | 4780/4780 |
| react-changelog | 1 | 0.30 MB | 598 ms | 24 ms | **24.4x** | 1/1 |
| node-api-docs | 70 | 4.75 MB | 5.41 s | 139 ms | **38.9x** | 70/70 |
| node-changelog-v22 | 1 | 0.88 MB | 1.50 s | 39 ms | **38.3x** | 1/1 |
| rust-book | 112 | 1.22 MB | 1.14 s | 51 ms | **22.3x** | 112/112 |
| vite-docs | 57 | 0.56 MB | 654 ms | 22 ms | **29.3x** | 57/57 |

Other parsers on the same input. Different output: markdown-it returns a token list and marked returns its own token tree, neither is mdast, and neither is a drop-in replacement. Shown for scale only.

| Input | markdown-it `parse` (tokens) | marked `lexer` (tokens) |
|---|---|---|
| README corpus | 2.23 s | 2.13 s |
| react-changelog | 87 ms | 48 ms |
| node-api-docs | 537 ms | 349 ms |
| node-changelog-v22 | 215 ms | 107 ms |
| rust-book | 133 ms | 73 ms |
| vite-docs | 83 ms | 44 ms |


Environment: Node v24.21.0, GitHub Actions ubuntu24 X64 (github-hosted), AMD EPYC 7763 64-Core Processor x2, linux x64. Each cell is the median of 7 rounds after one warm-up round, one fresh process per cell.

### MDX (`@mdx-js/mdx` `compile`)

Plain `format: 'md'` with `remark-gfm`, default parser versus samemark as the parser. `format: 'mdx'` loads `micromark-extension-mdxjs`, which is not in the stock GFM set, so samemark falls back there by design; it is measured on the files that are valid MDX to show the overhead is nil. Compiled output is compared.

| Input | Format | Files compiled | default | with samemark | Speedup | Identical output | samemark path |
|---|---|---|---|---|---|---|---|
| README corpus (1 in 16 sample) | md | 291 of 291 | 2.71 s | 814 ms | 3.3x | yes | 1164 fast, 0 fallback |
| README corpus (1 in 16 sample) | mdx | 198 of 291 | 1.43 s | 1.44 s | 1.0x | yes | 0 fast, 792 fallback |
| react-changelog | md | 1 of 1 | 840 ms | 265 ms | 3.2x | yes | 4 fast, 0 fallback |
| react-changelog | mdx | 0 of 1 | n/a | n/a | n/a | n/a | no file in this set is valid MDX |
| node-api-docs | md | 70 of 70 | 7.21 s | 1.75 s | 4.1x | yes | 280 fast, 0 fallback |
| node-api-docs | mdx | 0 of 70 | n/a | n/a | n/a | n/a | no file in this set is valid MDX |


### Real site: Astro 6.4.8 building 239 real markdown pages

rust-book, vite-docs, node-api-docs (6.53 MB of markdown), stock Astro markdown pipeline (remark-parse, remark-gfm, smartypants, Shiki, rehype-raw). Cold build each time (`dist`, `.astro` and the Vite cache removed), 3 builds per variant alternating, median shown, Node v24.21.0, AMD EPYC 7763 64-Core Processor x2.

| Parser | Build wall clock | Time inside the markdown parser | Parser share of build | Documents parsed | Fell back |
|---|---|---|---|---|---|
| remark-parse (default) | 36.1 s | 8.93 s | 24.7% | 239 | n/a |
| samemark | 27.8 s | 0.60 s | 2.1% | 239 | 0 |

Build time saved: 8.2 s (22.8%). Parser time saved: 8.33 s.

Individual builds (s): default 36.1, 35.5, 36.1; samemark 26.7, 27.8, 28.0.

<!-- bench:end -->

**Reading the react-markdown numbers.** The speedup per update is smaller than the parse-only number because React rendering and the hast to JSX step are unchanged. It differs by runtime: Node 6.5x to 7.3x, unthrottled Chromium 2.7x to 3.3x, throttled Chromium 4.8x to 5.8x. I do not have a verified explanation for why the ratio grows under CPU throttling (throttling slows the main thread; garbage collection and compilation threads are not slowed the same way, which is a guess, not a measurement). The absolute numbers are the practical result: a finished 30,000 character answer renders in 46 ms instead of 263 ms at 6x throttle.

Reproduce:

```sh
npm ci
npm run bench:small   # a few seconds: the synthetic corpus sample plus one changelog, laptop sized
npm run bench         # the full run (what CI ran), fetches the pinned documents first
```

`npm run bench` prints the exact tables above. Method: each cell is one fresh Node process (own JIT and heap),
one warm-up round, then the median of the stated number of rounds over all files of the input; GC is forced between
rounds; both sides are compared for identical output before timings are reported (the run fails otherwise).
markdown-it and marked are included for scale only: they produce tokens or HTML, not mdast, and are not drop-in
replacements. Documents: `bench/corpora.json` pins repository, commit and sha256 of every set.

## Bundle size

Minified with esbuild, ESM, platform neutral. `node scripts/size.mjs` reproduces the table.

<!-- size:start -->

| bundle | minified | gzip | brotli |
|---|---|---|---|
| samemark/core (parser + 6 helper packages, everything the fast path needs) | 87.4 KB | 31.2 KB | 27.0 KB |
| samemark/core for browsers (bundler uses the `browser` condition: entities decoded by the DOM) | 52.6 KB | 19.5 KB | 17.4 KB |
| samemark main entry, mdast-util-from-markdown left external (peer) | 88.4 KB | 31.7 KB | 27.5 KB |
| samemark main entry, everything bundled (includes mdast-util-from-markdown + micromark) | 144.0 KB | 47.1 KB | 40.9 KB |
|   of which: decode-named-character-reference (HTML entity table) | 35.0 KB | 11.6 KB | 9.6 KB |
| baseline: mdast-util-from-markdown + micromark-extension-gfm + mdast-util-gfm | 114.6 KB | 34.6 KB | 29.7 KB |
| baseline: unified + remark-parse + remark-gfm | 143.6 KB | 44.1 KB | 37.8 KB |

The `browser` row is what a bundler produces for browsers: `decode-named-character-reference` then decodes entities through the DOM instead of shipping its 35 KB table. Edge runtimes (`workerd`, `worker`, `edge-light`, `deno`) get the table.

<!-- size:end -->

## Where it fits

Sätteri, the Rust engine that is the default markdown processor in Astro 7, says in its docs that it
["isn't a drop-in replacement for unified"](https://satteri.bruits.org/docs/) and that existing remark and rehype
plugins won't run unmodified. samemark is for the projects that stay on unified: the same mdast, existing plugins run
unchanged, and it is plain JavaScript with no native binary.

## Credits

- [micromark](https://github.com/micromark/micromark), [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)
  and the GFM extensions by Titus Wormer and contributors define the behavior this parser reproduces, and supply the
  helper packages it imports (`micromark-util-*`, `ccount`, `decode-named-character-reference`).
- The [CommonMark](https://commonmark.org) spec and its examples.
- [unified](https://unifiedjs.com) and [remark](https://remark.js.org).

## License

MIT. Third-party licences of the code bundled in `dist/core.cjs` are in `dist/LICENSES.txt`.
