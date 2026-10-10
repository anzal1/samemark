// Real-site benchmark: an Astro site rendering real markdown docs, built with the stock remark pipeline and with
// samemark as the parser. Runs in CI only (installs Astro, builds ~240 pages several times).
//   node bench/perf/site/run-site.mjs [--runs=3] [--sets=rust-book,vite-docs,node-api-docs] [--dir=site-bench] [--json=f] [--markdown=f]
//
// How it is wired: astro.config.mjs sets `markdown.remarkPlugins` to `[samemark, timingPlugin]` (fast build) or
// `[timingPlugin]` (default build). Astro's pipeline is unified().use(remarkParse).use(remarkGfm).use(remarkSmartypants)
// then the user's remarkPlugins, so samemark replaces the parser after GFM is registered. `timingPlugin` wraps
// whatever parser is set at the end and adds up the time spent inside it, so the "markdown parse" share is measured,
// not estimated. Everything else (Shiki highlighting, rehype, Astro's own work, Vite) is unchanged.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'

const here = new URL('.', import.meta.url).pathname
const root = path.resolve(here, '../../..') + '/'
const args = process.argv.slice(2)
const val = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const runs = Number(val('runs', 3))
const sets = val('sets', 'rust-book,vite-docs,node-api-docs').split(',')
const dir = path.resolve(val('dir', root + 'site-bench')) + '/'
const jsonOut = val('json', '')
const mdOut = val('markdown', '')
const ASTRO = '6.4.8'

fs.rmSync(dir, {recursive: true, force: true})
fs.mkdirSync(dir + 'src/pages', {recursive: true})
fs.mkdirSync(dir + 'src/content/docs', {recursive: true})

// ---- content: the real docs, copied verbatim into a content collection ----
let pages = 0, bytes = 0
const slug = s => s.toLowerCase().replace(/[^a-z0-9/]+/g, '-').replace(/^-+|-+$/g, '')
for (const set of sets) {
  const base = path.resolve(process.env.SAMEMARK_CORPUS_DIR || root + '.corpus') + '/docs/' + set
  const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.md$/i.test(e.name)) {
    const rel = slug(set + '/' + path.relative(base, p).replace(/\.md$/i, '')) + '.md'
    fs.mkdirSync(path.dirname(dir + 'src/content/docs/' + rel), {recursive: true})
    // the docs' relative image files are not part of the fetch: point local images at a remote-looking URL so Astro
    // does not try to resolve them (the markdown text is otherwise untouched)
    const text = fs.readFileSync(p, 'utf8').replace(/(!\[[^\]]*\]\()(?!https?:|\/|data:|<)([^)\s]+)/g, '$1https://example.invalid/$2')
    fs.writeFileSync(dir + 'src/content/docs/' + rel, text); pages++; bytes += Buffer.byteLength(text)
  } } }
  if (!fs.existsSync(base)) throw new Error('missing docs set ' + set + ' (run node bench/fetch-corpora.mjs)')
  walk(base)
}

fs.writeFileSync(dir + 'package.json', JSON.stringify({name: 'samemark-site-bench', private: true, type: 'module', dependencies: {astro: ASTRO}}, null, 2))
fs.writeFileSync(dir + 'src/content.config.ts', `import {defineCollection} from 'astro:content'
import {glob} from 'astro/loaders'
export const collections = {docs: defineCollection({loader: glob({pattern: '**/*.md', base: './src/content/docs'})})}
`)
fs.writeFileSync(dir + 'src/pages/[...slug].astro', `---
import {getCollection, render} from 'astro:content'
export async function getStaticPaths() {
  const docs = await getCollection('docs')
  return docs.map(entry => ({params: {slug: entry.id}, props: {entry}}))
}
const {entry} = Astro.props
const {Content} = await render(entry)
---
<html lang="en"><head><meta charset="utf-8"><title>{entry.id}</title></head><body><main><Content /></main></body></html>
`)
fs.writeFileSync(dir + 'timing.mjs', `import fs from 'node:fs'
export const counters = {ms: 0, docs: 0, fallback: 0}
let registered = false
// remark plugin placed last: wraps the parser that is set by then and adds up the time spent in it
export function timing() {
  const parser = this.parser
  this.parser = function (...a) { const t0 = performance.now(); try { return parser.apply(this, a) } finally { counters.ms += performance.now() - t0; counters.docs++ } }
  if (!registered) {
    registered = true
    process.on('exit', () => { if (process.env.SITE_TIMING_FILE) fs.appendFileSync(process.env.SITE_TIMING_FILE, JSON.stringify({pid: process.pid, ...counters}) + '\\n') })
  }
}
`)
fs.writeFileSync(dir + 'astro.config.mjs', `import {defineConfig} from 'astro/config'
import samemark from ${JSON.stringify(pathToFileURL(root + 'index.js').href)}
import {timing, counters} from './timing.mjs'

const fast = process.env.SITE_PARSER === 'samemark'
export default defineConfig({
  markdown: {remarkPlugins: fast ? [[samemark, {onFallback: () => { counters.fallback++ }}], timing] : [timing]}
})
`)

// ---- install ----
const sh = (cmd, a, o = {}) => spawnSync(cmd, a, {cwd: dir, stdio: 'inherit', ...o})
console.log(`site: ${pages} pages, ${(bytes / 1e6).toFixed(2)} MB of markdown (${sets.join(', ')}), astro ${ASTRO}`)
if (sh('npm', ['install', '--no-audit', '--no-fund']).status !== 0) throw new Error('npm install failed in the site project')

// ---- builds: alternate default / samemark so drift hits both ----
const results = {default: [], samemark: []}
const order = []
for (let i = 0; i < runs; i++) order.push(i % 2 === 0 ? ['default', 'samemark'] : ['samemark', 'default'])
// one unmeasured build first: warms the OS file cache and npm's compile caches for both
const build = (variant, measured) => {
  for (const d of ['dist', '.astro', 'node_modules/.astro', 'node_modules/.vite']) fs.rmSync(dir + d, {recursive: true, force: true})
  const timing = dir + `timing-${variant}.jsonl`
  fs.rmSync(timing, {force: true})
  const t0 = performance.now()
  const r = sh('npx', ['astro', 'build'], {env: {...process.env, SITE_PARSER: variant, SITE_TIMING_FILE: timing, ASTRO_TELEMETRY_DISABLED: '1', CI: '1'}})
  const wall = performance.now() - t0
  if (r.status !== 0) throw new Error(`astro build failed (${variant})`)
  const rows = fs.existsSync(timing) ? fs.readFileSync(timing, 'utf8').trim().split('\\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const sum = k => rows.reduce((a, r) => a + r[k], 0)
  const out = {wall, parseMs: sum('ms'), docs: sum('docs'), fallback: sum('fallback')}
  console.log(`[${variant}] ${measured ? 'run' : 'warm-up'}: build ${(wall / 1000).toFixed(1)} s, parser ${out.parseMs.toFixed(0)} ms over ${out.docs} documents, fallbacks ${out.fallback}`)
  if (measured) results[variant].push(out)
}
build('default', false)
for (const pair of order) for (const v of pair) build(v, true)

const med = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const sum = v => ({wall: med(results[v].map(r => r.wall)), parseMs: med(results[v].map(r => r.parseMs)), docs: results[v][0].docs, fallback: med(results[v].map(r => r.fallback))})
const d = sum('default'), s = sum('samemark')
const lines = [
  '### Real site: Astro ' + ASTRO + ' building ' + pages + ' real markdown pages',
  '',
  `${sets.join(', ')} (${(bytes / 1e6).toFixed(2)} MB of markdown), stock Astro markdown pipeline (remark-parse, remark-gfm, smartypants, Shiki, rehype-raw). Cold build each time (\`dist\`, \`.astro\` and the Vite cache removed), ${runs} builds per variant alternating, median shown, Node ${process.version}, ${os.cpus()[0].model.trim()} x${os.cpus().length}.`,
  '',
  '| Parser | Build wall clock | Time inside the markdown parser | Parser share of build | Documents parsed | Fell back |',
  '|---|---|---|---|---|---|',
  `| remark-parse (default) | ${(d.wall / 1000).toFixed(1)} s | ${(d.parseMs / 1000).toFixed(2)} s | ${(100 * d.parseMs / d.wall).toFixed(1)}% | ${d.docs} | n/a |`,
  `| samemark | ${(s.wall / 1000).toFixed(1)} s | ${(s.parseMs / 1000).toFixed(2)} s | ${(100 * s.parseMs / s.wall).toFixed(1)}% | ${s.docs} | ${s.fallback} |`,
  '',
  `Build time saved: ${((d.wall - s.wall) / 1000).toFixed(1)} s (${(100 * (d.wall - s.wall) / d.wall).toFixed(1)}%). Parser time saved: ${((d.parseMs - s.parseMs) / 1000).toFixed(2)} s.`,
  '',
  'Individual builds (s): default ' + results.default.map(r => (r.wall / 1000).toFixed(1)).join(', ') + '; samemark ' + results.samemark.map(r => (r.wall / 1000).toFixed(1)).join(', ') + '.'
]
console.log('\n' + lines.join('\n'))
if (jsonOut) { fs.mkdirSync(path.dirname(path.resolve(jsonOut)), {recursive: true}); fs.writeFileSync(jsonOut, JSON.stringify({pages, bytes, sets, astro: ASTRO, results, summary: {default: d, samemark: s}}, null, 1)) }
if (mdOut) { fs.mkdirSync(path.dirname(path.resolve(mdOut)), {recursive: true}); fs.writeFileSync(mdOut, lines.join('\n') + '\n') }
if (s.fallback > 0 || s.docs === 0) { console.error('samemark fell back or did not run: the comparison is invalid'); process.exitCode = 1 }
