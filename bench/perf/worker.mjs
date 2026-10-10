// One benchmark task in its own process (so impls never share a JIT or heap):
//   node --expose-gc bench/perf/worker.mjs <config.json>   -> prints one JSON line
// config: {task: 'parse'|'e2e'|'mdx', impl, files: [paths], rounds, mdxFormat?}
import fs from 'node:fs'
import crypto from 'node:crypto'

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const srcs = (cfg.files || []).map(f => fs.readFileSync(f, 'utf8'))
const bytes = srcs.reduce((a, s) => a + Buffer.byteLength(s), 0)
const md5 = s => crypto.createHash('md5').update(s).digest('hex').slice(0, 10)
// canonical JSON: key order must not matter for the identity check (undefined fields are dropped like JSON does)
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  }
  return JSON.stringify(v) ?? 'null'
}
const gc = () => { if (globalThis.gc) globalThis.gc() }
const now = () => performance.now()
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

async function timed(fn, rounds, warmups = 1) {
  const times = []
  for (let r = -warmups; r < rounds; r++) {
    gc()
    const t0 = now()
    const extra = await fn(r < 0)
    const dt = now() - t0
    if (r >= 0) times.push({ms: dt, extra})
  }
  return times
}

const out = {task: cfg.task, impl: cfg.impl, files: srcs.length, bytes, node: process.version}

if (cfg.task === 'parse') {
  let parseOne
  if (cfg.impl === 'samemark') { const {parse} = await import('../../core.js'); parseOne = s => parse(s) }
  else if (cfg.impl === 'reference') {
    const {fromMarkdown} = await import('mdast-util-from-markdown')
    const {gfm} = await import('micromark-extension-gfm')
    const {gfmFromMarkdown} = await import('mdast-util-gfm')
    const opts = {extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()]}
    parseOne = s => fromMarkdown(s, opts)
  } else if (cfg.impl === 'markdown-it') { const MarkdownIt = (await import('markdown-it')).default; const md = new MarkdownIt(); parseOne = s => md.parse(s, {}) }
  else if (cfg.impl === 'marked') { const {marked} = await import('marked'); parseOne = s => marked.lexer(s) }
  else throw new Error('unknown impl ' + cfg.impl)
  if (cfg.verify) { // identity: per-file hash of the full tree (positions included); not timed
    out.fileHashes = srcs.map(s => md5(canon(parseOne(s))))
  }
  const times = await timed(() => { for (let i = 0; i < srcs.length; i++) parseOne(srcs[i]) }, cfg.rounds)
  out.rounds = times.map(t => t.ms)
} else if (cfg.task === 'e2e') {
  const {unified} = await import('unified')
  const {default: remarkGfm} = await import('remark-gfm')
  const {default: remarkRehype} = await import('remark-rehype')
  const {default: rehypeStringify} = await import('rehype-stringify')
  let parse1, run1, str1
  if (cfg.impl === 'remark' || cfg.impl === 'samemark') {
    const parser = cfg.impl === 'remark' ? (await import('remark-parse')).default : (await import('../../index.js')).default
    const plugins = [remarkGfm]
    if (cfg.pipeline === 'content') { plugins.push((await import('remark-frontmatter')).default, (await import('remark-math')).default) }
    const proc = unified().use(parser).use(plugins).use(remarkRehype).use(rehypeStringify).freeze()
    parse1 = s => proc.parse(s); run1 = t => proc.runSync(t); str1 = h => proc.stringify(h)
    out.stats = cfg.impl === 'samemark' ? (await import('../../index.js')).stats : undefined
  } else if (cfg.impl === 'markdown-it') {
    const MarkdownIt = (await import('markdown-it')).default; const md = new MarkdownIt()
    parse1 = s => s; run1 = s => s; str1 = s => md.render(s)
  } else if (cfg.impl === 'marked') {
    const {marked} = await import('marked')
    parse1 = s => s; run1 = s => s; str1 = s => marked.parse(s)
  } else throw new Error('unknown impl ' + cfg.impl)
  if (cfg.verify) out.fileHashes = srcs.map(s => md5(str1(run1(parse1(s)))))
  const stage = {parse: 0, run: 0, stringify: 0}
  const times = await timed(() => {
    let a = 0, b = 0, c = 0
    for (let i = 0; i < srcs.length; i++) {
      const t0 = now(); const tree = parse1(srcs[i]); const t1 = now(); const hast = run1(tree); const t2 = now(); str1(hast); const t3 = now()
      a += t1 - t0; b += t2 - t1; c += t3 - t2
    }
    return {parse: a, run: b, stringify: c}
  }, cfg.rounds)
  out.rounds = times.map(t => t.ms)
  out.stages = {parse: median(times.map(t => t.extra.parse)), run: median(times.map(t => t.extra.run)), stringify: median(times.map(t => t.extra.stringify))}
  if (cfg.impl === 'samemark') { const {stats} = await import('../../index.js'); out.stats = {...stats} }
} else if (cfg.task === 'mdx') {
  const {compile} = await import('@mdx-js/mdx')
  const {default: remarkGfm} = await import('remark-gfm')
  const fast = cfg.impl === 'samemark'
  const {default: remarkParseFast, stats} = await import('../../index.js')
  const remarkPlugins = fast ? [remarkParseFast, remarkGfm] : [remarkGfm]
  const format = cfg.mdxFormat
  const compileOne = async s => String(await compile(s, {format, remarkPlugins}))
  // validity: plain MDX rejects much real-world markdown (`<`, `{`); only files that compile are timed in mdx mode
  const valid = []
  const hashes = []
  for (let i = 0; i < srcs.length; i++) {
    try { const code = await compileOne(srcs[i]); valid.push(i); hashes.push(md5(code)) } catch { /* not valid in this format */ }
  }
  out.valid = valid.length
  out.fileHashes = hashes
  out.validFiles = valid.map(i => cfg.files[i])
  const use = valid.map(i => srcs[i])
  out.bytes = use.reduce((a, s) => a + Buffer.byteLength(s), 0)
  const before = {...stats}
  const times = await timed(async () => { for (const s of use) await compileOne(s) }, cfg.rounds)
  out.rounds = times.map(t => t.ms)
  if (fast) out.stats = {fast: stats.fast - before.fast, fallback: stats.fallback - before.fallback, lastFallbackReason: stats.lastFallbackReason}
}
else if (cfg.task === 'reactmd') {
  const React = await import('react')
  const {renderToStaticMarkup} = await import('react-dom/server')
  const {default: Markdown} = await import('react-markdown')
  const {default: remarkGfm} = await import('remark-gfm')
  const {measure} = await import('./reactmd-core.mjs')
  const fast = cfg.impl === 'samemark'
  const {default: remarkParseFast, stats} = await import('../../index.js')
  const remarkPlugins = fast ? [remarkParseFast, remarkGfm] : [remarkGfm]
  const render = text => renderToStaticMarkup(React.createElement(Markdown, {remarkPlugins}, text))
  Object.assign(out, measure({render, reps: cfg.reps, streams: cfg.streams, lengths: cfg.lengths, gc}))
  if (fast) out.stats = {...stats}
}
out.median = out.rounds && median(out.rounds)
console.log(JSON.stringify(out))
