// samemark/stream: after every push the tree equals a full parse of everything pushed so far, and equals micromark at
// checkpoints; finished blocks keep their identity.
import test from 'node:test'
import assert from 'node:assert/strict'
import {fromMarkdown} from 'mdast-util-from-markdown'
import {gfm} from 'micromark-extension-gfm'
import {gfmFromMarkdown} from 'mdast-util-gfm'
import {frontmatter} from 'micromark-extension-frontmatter'
import {frontmatterFromMarkdown} from 'mdast-util-frontmatter'
import {math} from 'micromark-extension-math'
import {mathFromMarkdown} from 'mdast-util-math'
import {createStreamParser} from '../stream.js'
import {parse} from '../core.js'
import {normalizeMatters, parse as blockParse} from '../src/block.js'
import {chatAnswer} from '../bench/perf/chat-text.mjs'
import {firstDiff} from '../bench/common.mjs'
import {groups} from './edge-cases.mjs'
import {loadDocs} from '../bench/corpus.mjs'

const plain = t => JSON.parse(JSON.stringify(t))
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }
const refOpts = {extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()]}

function replay(text, {seed = 1, max = 40, options, micromarkEvery = 0, refOptions = refOpts, popts} = {}) {
  const r = rng(seed)
  const s = createStreamParser(options)
  let pos = 0, n = 0
  while (pos < text.length) {
    const from = pos
    pos = Math.min(text.length, pos + 1 + Math.floor(r() * max))
    const tree = s.push(text.slice(from, pos))
    n++
    const prefix = text.slice(0, pos)
    const d = firstDiff(plain(blockParse(prefix, popts)), plain(tree))
    assert.equal(d, null, `after ${pos} chars: ${JSON.stringify(d).slice(0, 300)}`)
    if (micromarkEvery && n % micromarkEvery === 0) assert.equal(firstDiff(plain(fromMarkdown(prefix, refOptions)), plain(tree)), null, `micromark after ${pos} chars`)
  }
  assert.equal(firstDiff(plain(s.end()), plain(blockParse(text, popts))), null)
}

test('chat-style answer in random chunks equals a full parse after every push and micromark at checkpoints', () => {
  replay(chatAnswer(5000), {seed: 3, max: 30, micromarkEvery: 25})
})

test('edge inputs in random chunks (CRLF, CR, tabs, nesting, unicode, definitions)', () => {
  let i = 0
  for (const [group, cases] of Object.entries(groups)) {
    for (const [name, src] of Object.entries(cases)) {
      if (src.length > 3000) continue
      replay(src, {seed: ++i, max: 12})
    }
  }
})

test('reference links and footnotes resolved by a definition that arrives later', () => {
  replay('See [one][a] and [two] and text[^n].\n\nMore *text*.\n\n[a]: /x "t"\n[two]: /y\n\n[^n]: The note.\n\nend\n', {seed: 5, max: 6, micromarkEvery: 3})
})

test('corpus documents in random chunks (docs corpus when fetched, synthetic otherwise)', () => {
  const items = loadDocs({sample: 25}).slice(0, 14)
  assert.ok(items.length > 0)
  items.forEach((it, i) => replay(it.src.slice(0, 4000), {seed: 100 + i, max: 60}))
})

test('frontmatter and math options', () => {
  const doc = '---\ntitle: x\n---\n\n# h $a$ $$b$$\n\n$$\nc\n$$\n\ntext *e*\n'
  const options = {frontmatter: true, math: true}
  const refOptions = {extensions: [gfm(), frontmatter(), math()], mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(), mathFromMarkdown()]}
  replay(doc, {seed: 9, max: 5, options, popts: {frontmatter: normalizeMatters(undefined), math: {single: true}}, micromarkEvery: 2, refOptions})
  const toml = '+++\nt = 1\n+++\ntext\n'
  replay(toml, {seed: 10, max: 4, options: {frontmatter: ['yaml', 'toml']}, popts: {frontmatter: normalizeMatters(['yaml', 'toml'])}})
})

test('finished blocks keep their identity and cost does not grow with the message', () => {
  const text = chatAnswer(20000)
  const s = createStreamParser()
  let first = null, reused = 0, pushes = 0
  for (let i = 0; i < text.length; i += 20) {
    const tree = s.push(text.slice(i, i + 20))
    pushes++
    if (first === null && tree.children.length > 3) first = tree.children[0]
    else if (first !== null && tree.children[0] === first) reused++
  }
  assert.ok(first, 'a block finished')
  assert.ok(reused / pushes > 0.9, `first block reused on ${reused} of ${pushes} pushes`)
})

test('reset starts a new message', () => {
  const s = createStreamParser()
  s.push('# a\n\nb')
  s.reset()
  assert.equal(firstDiff(plain(s.push('c *d*')), plain(parse('c *d*'))), null)
})

test('BOM and NUL in the first chunk', () => {
  const s = createStreamParser()
  assert.equal(firstDiff(plain(s.push('﻿a\0b')), plain(parse('﻿a\0b'))), null)
})

// the React example renders exactly what react-markdown renders for the whole message
test('examples/react-chat StreamMarkdown output equals react-markdown (HTML) at many prefixes', async () => {
  const React = await import('react')
  const {renderToStaticMarkup} = await import('react-dom/server')
  const {default: Markdown} = await import('react-markdown')
  const {default: remarkGfm} = await import('remark-gfm')
  const {build} = await import('esbuild')
  const root = new URL('../', import.meta.url).pathname
  const outfile = root + 'node_modules/.cache/samemark-example.mjs'
  await build({entryPoints: [root + 'examples/react-chat/StreamMarkdown.jsx'], outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', alias: {'samemark/stream': root + 'stream.js'}, logLevel: 'error'})
  const {StreamMarkdown} = await import(outfile + '?' + Date.now())
  const text = chatAnswer(6000) + '\n\nA [ref link][r], <b>raw html</b>, [bad](javascript:alert(1)) and [good](https://a.b).\n\n[r]: https://example.com/r "T"\n'
  const s = createStreamParser()
  let n = 0
  for (let pos = 0; pos < text.length; pos += 37) {
    const tree = s.push(text.slice(pos, pos + 37))
    if (++n % 7 && pos + 37 < text.length) continue
    const prefix = text.slice(0, pos + 37)
    const a = renderToStaticMarkup(React.createElement(StreamMarkdown, {tree}))
    const b = renderToStaticMarkup(React.createElement(Markdown, {remarkPlugins: [remarkGfm]}, prefix))
    assert.equal(a, b, `HTML differs after ${prefix.length} characters`)
  }
})
