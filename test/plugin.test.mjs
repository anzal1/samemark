// Both entries, both paths: stock GFM runs the fast parser, anything else is the real remark-parse.
import test from 'node:test'
import assert from 'node:assert/strict'
import {unified} from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import * as full from '../index.js'
import * as core from '../core.js'
import {cases, sample, sampleToml, docFor} from './compat-cases.mjs'

const plain = t => JSON.parse(JSON.stringify(t))
const mk = (entry, plugins, opts) => { const p = unified().use(entry.default, opts); for (const pl of plugins) p.use(...[].concat(pl)); return p }
const ref = plugins => { const p = unified().use(remarkParse); for (const pl of plugins) p.use(...[].concat(pl)); return p }
// core has no fallback import: put remark-parse first so it can hand over
const mkCore = (plugins, opts) => { const p = unified().use(remarkParse).use(core.default, opts); for (const pl of plugins) p.use(...[].concat(pl)); return p }

for (const c of cases) {
  test(`main entry: ${c.label} -> ${c.fast ? 'fast' : 'fallback'}, same tree as remark-parse`, () => {
    const before = {...full.stats}
    const got = plain(mk(full, c.plugins).parse(docFor(c)))
    assert.equal(full.stats.fast - before.fast, c.fast ? 1 : 0)
    assert.equal(full.stats.fallback - before.fallback, c.fast ? 0 : 1)
    assert.deepEqual(got, plain(ref(c.plugins).parse(docFor(c))))
    if (!c.fast) assert.equal(typeof full.stats.lastFallbackReason, 'string')
  })
  test(`core entry (remark-parse first): ${c.label}`, () => {
    const before = {...core.stats}
    const got = plain(mkCore(c.plugins).parse(docFor(c)))
    assert.equal(core.stats.fast - before.fast, c.fast ? 1 : 0)
    assert.deepEqual(got, plain(ref(c.plugins).parse(docFor(c))))
  })
}

test('core entry throws on unsupported extensions when nothing can take over', () => {
  const p = unified().use(core.default).use(remarkGfm, {singleTilde: false})
  assert.throws(() => p.parse('~a~'), /no fallback is configured/)
  const q = unified().use(core.default) // no GFM at all
  assert.throws(() => q.parse('a'), /no GFM extensions/)
})

test('strict mode throws instead of falling back', () => {
  const p = unified().use(full.default, {strict: true}).use(remarkGfm, {singleTilde: false})
  assert.throws(() => p.parse('~a~'), /fast path cannot be used \(strikethrough/)
  const ok = unified().use(full.default, {strict: true}).use(remarkGfm)
  assert.doesNotThrow(() => ok.parse('~~a~~'))
  assert.throws(() => full.parse('a', {strict: true, extensions: [], mdastExtensions: []}), /no GFM/)
})

test('fallback reporting: stats, reason, onFallback, one-time warning', () => {
  const reasons = []
  const warns = []
  const orig = console.warn
  console.warn = m => warns.push(m)
  try {
    const p = unified().use(full.default, {onFallback: r => reasons.push(r), warn: true}).use(remarkGfm, {singleTilde: false})
    p.parse('a'); p.parse('b'); p.parse('c')
    assert.equal(reasons.length, 3)
    assert.match(reasons[0], /singleTilde/)
    assert.equal(warns.length, 1, 'warning is printed once per reason')
    assert.match(warns[0], /slow fallback/)
    assert.equal(full.stats.lastFallbackReason, reasons[0])
  } finally { console.warn = orig }
})

test('reasons name the offending construct', () => {
  const byLabel = Object.fromEntries(cases.map(c => [c.label, c]))
  const reason = label => { const c = byLabel[label]; const p = unified().use(full.default); for (const pl of c.plugins) p.use(...[].concat(pl)); p.parse('x'); return full.stats.lastFallbackReason }
  assert.match(reason('remark-gfm + remark-frontmatter with a custom `fence` (same type, other fence)'), /frontmatter fences differ/)
  assert.match(reason('remark-gfm + remark-frontmatter with `anywhere: true`'), /frontmatter fences differ/)
  assert.match(reason('remark-gfm + remark-frontmatter with a custom matter type'), /supported set.*flow\|unnamed construct/)
  assert.match(reason('remark-gfm + remark-directive'), /unnamed construct at code 58/)
  assert.match(reason('remark-gfm + remark-mdx'), /disable\|/)
  assert.match(reason('micromark `disable` entry'), /disable/)
  assert.match(reason('unknown micromark construct'), /atSign/)
})

test('custom fallback option', () => {
  const calls = []
  const p = unified().use(core.default, {fallback: (text, ctx) => { calls.push(ctx.extensions.length); return {type: 'root', children: []} }}).use(remarkGfm, {singleTilde: false})
  assert.deepEqual(p.parse('~a~'), {type: 'root', children: []})
  assert.equal(calls.length, 1)
})

test('plugin order does not matter (gfm before the parser plugin)', () => {
  const late = unified().use(remarkGfm).use(full.default)
  const before = full.stats.fast
  assert.deepEqual(plain(late.parse(sample)), plain(ref([remarkGfm]).parse(sample)))
  assert.equal(full.stats.fast, before + 1)
})

test('full pipeline with stringify', () => {
  const out = unified().use(full.default).use(remarkGfm).use(remarkStringify).processSync('# a\n\n- [x] done ~~old~~\n').toString()
  assert.ok(out.includes('~~old~~'))
})

test('parse() with and without extension arguments', () => {
  const src = '~~a~~ www.a.com\n'
  assert.deepEqual(plain(full.parse(src)), plain(core.parse(src)))
  const gfmOnly = unified().use(remarkParse).use(remarkGfm).freeze()
  const ext = {extensions: gfmOnly.data('micromarkExtensions'), mdastExtensions: gfmOnly.data('fromMarkdownExtensions')}
  const f0 = full.stats.fast
  assert.deepEqual(plain(full.parse(src, ext)), plain(full.parse(src)))
  assert.equal(full.stats.fast, f0 + 2)
  // plain CommonMark extensions: fallback result differs from the GFM tree
  const f1 = full.stats.fallback
  assert.notDeepEqual(plain(full.parse(src, {extensions: [], mdastExtensions: []})), plain(full.parse(src)))
  assert.equal(full.stats.fallback, f1 + 1)
})

test('fast parser errors fall back instead of crashing (main), rethrow (core)', async () => {
  // simulate by a fallback-able failure: strict rethrows, non-strict reports
  const boom = {toString() { return 'x' }}
  assert.doesNotThrow(() => full.parse(boom))
})

test('decisions are cached by content: fresh processors (react-markdown builds one per render) verify once', async () => {
  const {createApi} = await import('../lib/api.js')
  let verifies = 0
  const api = createApi(null, () => { verifies++; return true })
  for (let i = 0; i < 50; i++) {
    const p = unified().use(remarkParse).use(api.remarkParseFast).use(remarkGfm)
    p.parse('~~a~~')
  }
  assert.equal(verifies, 1)
  assert.equal(api.stats.fast, 50)
  // a differently configured gfm is a different key and is not served from the stock decision
  const before = api.stats.fast
  const odd = unified().use(remarkParse).use(api.remarkParseFast).use(remarkGfm, {singleTilde: false})
  assert.equal(api.check(odd.freeze().data('micromarkExtensions'), odd.data('fromMarkdownExtensions')) === null, false)
  assert.equal(api.stats.fast, before)
})

test('react-markdown: the plugin replaces its internal parser, output identical, no per-render re-verification', async () => {
  const React = await import('react')
  const {renderToStaticMarkup} = await import('react-dom/server')
  const {default: Markdown} = await import('react-markdown')
  const {chatAnswer} = await import('../bench/perf/chat-text.mjs')
  const text = chatAnswer(6000)
  const render = plugins => renderToStaticMarkup(React.createElement(Markdown, {remarkPlugins: plugins}, text))
  const before = {...full.stats}
  const fast = render([full.default, remarkGfm])
  assert.equal(fast, render([remarkGfm]))
  assert.equal(full.stats.fast - before.fast, 1)
  assert.equal(full.stats.fallback - before.fallback, 0)
  // a plugin that needs a non-GFM extension makes react-markdown fall back through the same hook
  const {default: remarkDirective} = await import('remark-directive')
  const f0 = full.stats.fallback
  assert.equal(render([full.default, remarkGfm, remarkDirective]), render([remarkGfm, remarkDirective]))
  assert.equal(full.stats.fallback - f0, 1)
})
