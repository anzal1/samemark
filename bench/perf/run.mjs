// One command: node bench/perf/run.mjs [--small] [--only=parse,e2e,mdx] [--rounds=N] [--json=file] [--markdown=file]
// Runs every task in a fresh child process, checks outputs are identical where they must be, and prints the
// exact tables used in README.md. `--small` is a laptop-sized sample (a few seconds).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {syntheticDocs} from '../synthetic.mjs'

const here = new URL('.', import.meta.url).pathname
const root = path.resolve(here, '../..') + '/'
const args = process.argv.slice(2)
const flag = n => args.includes('--' + n)
const val = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const small = flag('small')
const only = val('only', 'parse,e2e,mdx,reactmd').split(',')
const rounds = Number(val('rounds', small ? 3 : 7))
const jsonOut = val('json', '')
const mdOut = val('markdown', '')
const dataset = val('dataset', '') // optional: restrict to dataset names (comma separated)

// ---- datasets ----
if (!flag('no-fetch')) {
  const r = spawnSync(process.execPath, [here + '../fetch-corpora.mjs', ...(small ? ['--small'] : [])], {stdio: ['ignore', 'ignore', 'inherit']})
  if (r.status !== 0) { console.error('fetching the corpora failed (use --no-fetch to skip)'); process.exit(1) }
}
const hashMod = (name, n) => crypto.createHash('md5').update(name).digest().readUInt32BE(0) % n
function listMd(dir) {
  const out = []
  const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.md$/i.test(e.name)) out.push(p) } }
  if (fs.existsSync(dir)) walk(dir)
  return out.sort()
}
const manifest = JSON.parse(fs.readFileSync(here + '../corpora.json', 'utf8'))
const corpusRoot = process.env.SAMEMARK_CORPUS_DIR || path.resolve(root, '.corpus')
// the synthetic corpus is generated, then written out so the worker processes can read it like any other files
function syntheticFiles() {
  const dir = path.join(corpusRoot, 'synthetic')
  fs.mkdirSync(dir, {recursive: true})
  return syntheticDocs(240).map(d => { const f = path.join(dir, path.basename(d.id)); fs.writeFileSync(f, d.src); return f })
}
function datasets(sampleN) {
  const list = []
  for (const s of manifest.sources) {
    if (s.role !== 'docs' || (small && !s.small)) continue
    const files = listMd(path.join(corpusRoot, 'docs', s.name))
    if (files.length) list.push({name: s.name, key: s.name, files, kind: s.kind})
  }
  list.push({name: 'synthetic corpus (240 generated documents)', key: 'synthetic', files: syntheticFiles().filter(f => !sampleN || hashMod(path.basename(f), sampleN) === 0)})
  if (flag('readme')) {
    const files = listMd(path.join(corpusRoot, 'readme')).filter(f => !sampleN || hashMod(path.basename(f), sampleN) === 0)
    if (files.length) list.push({name: 'README corpus' + (sampleN ? ` (1 in ${sampleN} sample)` : ''), key: 'readme', files})
    else console.error('no README corpus found (node bench/readme-corpus.mjs rebuilds it from npm, slowly)')
  }
  return dataset ? list.filter(d => dataset.split(',').includes(d.key)) : list
}
const sizeOf = files => files.reduce((a, f) => a + fs.statSync(f).size, 0)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samemark-bench-'))
process.on('exit', () => fs.rmSync(tmpDir, {recursive: true, force: true}))
function worker(cfg) {
  // the file list is far beyond the length limit of a single argv entry: pass the config through a file
  const file = path.join(tmpDir, 'cfg.json')
  fs.writeFileSync(file, JSON.stringify(cfg))
  const r = spawnSync(process.execPath, ['--expose-gc', here + 'worker.mjs', file], {maxBuffer: 1 << 28, encoding: 'utf8', env: cfg.task === 'reactmd' ? {...process.env, NODE_ENV: 'production'} : process.env}) // React's development build is several times slower
  if (r.status !== 0) throw new Error(`worker failed (${cfg.task}/${cfg.impl}): ${r.error || ''} ${(r.stderr || '').slice(0, 2000)}`)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}
const med = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const fmtMs = ms => ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(0) + ' ms'
const mb = b => (b / 1e6).toFixed(2) + ' MB'
const x = (a, b) => (a / b).toFixed(1) + 'x'
const range = r => `${fmtMs(Math.min(...r))} to ${fmtMs(Math.max(...r))}`

const env = {
  node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0].model.trim(), cores: os.cpus().length,
  runner: process.env.RUNNER_NAME ? `GitHub Actions ${process.env.ImageOS || ''} ${process.env.RUNNER_ARCH || ''} (${process.env.RUNNER_ENVIRONMENT || ''})`.trim() : 'local machine',
  rounds, small
}
const result = {env, parse: [], e2e: [], mdx: [], reactmd: null}
const lines = []
const log = s => { lines.push(s); console.log(s) }
log(`Environment: Node ${env.node}, ${env.runner}, ${env.cpu} x${env.cores}, ${env.platform}. Each cell is the median of ${rounds} rounds after one warm-up round, one fresh process per cell.`)
log('')

// ---- end to end ----
if (only.includes('e2e')) {
  const sets = datasets(small ? 48 : 4)
  log('### End to end: markdown to HTML with unified\n')
  log('`unified().use(parser).use(remarkGfm).use(remarkRehype).use(rehypeStringify)`, with `remark-parse` or with samemark as the parser. Output HTML is compared file by file.\n')
  log('| Input | Files | Size | remark-parse | samemark | Speedup | Parse share before | Parse share after | Identical HTML |')
  log('|---|---|---|---|---|---|---|---|---|')
  for (const d of sets) {
    const base = {task: 'e2e', files: d.files, rounds}
    const a = worker({...base, impl: 'remark', verify: true})
    const b = worker({...base, impl: 'samemark', verify: true})
    const ident = a.fileHashes.filter((h, i) => h === b.fileHashes[i]).length
    const share = o => o.stages.parse / (o.stages.parse + o.stages.run + o.stages.stringify)
    result.e2e.push({dataset: d.name, files: d.files.length, bytes: a.bytes, remark: a, samemark: b, identical: ident})
    log(`| ${d.name} | ${d.files.length} | ${mb(a.bytes)} | ${fmtMs(a.median)} | ${fmtMs(b.median)} | **${x(a.median, b.median)}** | ${(100 * share(a)).toFixed(0)}% | ${(100 * share(b)).toFixed(0)}% | ${ident}/${d.files.length} |`)
    if (b.stats && b.stats.fallback) log(`<!-- samemark took the fallback ${b.stats.fallback} times -->`)
  }
  log('')
  // content pipeline: what a docs or blog site runs (remark-gfm + remark-frontmatter + remark-math)
  {
    const fmDir = path.join(tmpDir, 'fm-docs')
    fs.mkdirSync(fmDir, {recursive: true})
    const withFm = sets.filter(d => d.key === 'synthetic' || d.key === 'readme').map(d => ({...d, name: d.name + ' with a frontmatter block added', files: d.files.map(f => {
      const out = path.join(fmDir, path.basename(f))
      fs.writeFileSync(out, `---\ntitle: "${path.basename(f, '.md')}"\ndate: 2026-01-01\ntags: [docs, readme]\ndraft: false\n---\n\n` + fs.readFileSync(f, 'utf8'))
      return out
    })}))
    const contentSets = [...withFm, ...sets.filter(d => d.key === 'vite-docs' || d.key === 'react-changelog')]
    log('Content pipeline, as a docs or blog site runs it: `remark-gfm`, `remark-frontmatter` (yaml) and `remark-math` before `remark-rehype`. `vite-docs` has real frontmatter in every page; the synthetic (or README) documents get a generated block so every file has one. Both sides are compared on the HTML.\n')
    log('| Input | Files | Size | remark-parse | samemark | Speedup | Identical HTML | samemark path |')
    log('|---|---|---|---|---|---|---|---|')
    result.e2eContent = []
    for (const d of contentSets) {
      const base = {task: 'e2e', files: d.files, rounds, pipeline: 'content'}
      const a = worker({...base, impl: 'remark', verify: true})
      const b = worker({...base, impl: 'samemark', verify: true})
      const ident = a.fileHashes.filter((h, i) => h === b.fileHashes[i]).length
      result.e2eContent.push({dataset: d.name, files: d.files.length, bytes: a.bytes, remark: a, samemark: b, identical: ident})
      log(`| ${d.name} | ${d.files.length} | ${mb(a.bytes)} | ${fmtMs(a.median)} | ${fmtMs(b.median)} | **${x(a.median, b.median)}** | ${ident}/${d.files.length} | ${b.stats.fast ? 'fast' : ''}${b.stats.fallback ? ' ' + b.stats.fallback + ' fallback' : ''} |`)
    }
    log('')
  }
  log('For context, other converters on the same input (different pipeline and output: HTML strings, no mdast, not drop-in replacements):\n')
  log('| Input | markdown-it `render` (HTML) | marked `parse` (HTML) |')
  log('|---|---|---|')
  for (const d of sets) {
    const base = {task: 'e2e', files: d.files, rounds}
    const m = worker({...base, impl: 'markdown-it'}); const k = worker({...base, impl: 'marked'})
    result.e2e.find(r => r.dataset === d.name).others = {markdownIt: m, marked: k}
    log(`| ${d.name} | ${fmtMs(m.median)} | ${fmtMs(k.median)} |`)
  }
  log('')
}

// ---- parse only ----
if (only.includes('parse')) {
  const sets = datasets(small ? 48 : 0)
  log('### Parse only\n')
  log('Same mdast on both sides (`mdast-util-from-markdown` with `micromark-extension-gfm` and `mdast-util-gfm`, the reference). "Identical" counts files whose full tree, positions included, is equal.\n')
  log('| Input | Files | Size | mdast-util-from-markdown + GFM | samemark | Speedup | Identical |')
  log('|---|---|---|---|---|---|---|')
  const others = []
  for (const d of sets) {
    const base = {task: 'parse', files: d.files, rounds}
    const a = worker({...base, impl: 'reference', verify: true})
    const b = worker({...base, impl: 'samemark', verify: true})
    const ident = a.fileHashes.filter((h, i) => h === b.fileHashes[i]).length
    result.parse.push({dataset: d.name, files: d.files.length, bytes: a.bytes, reference: a, samemark: b, identical: ident})
    log(`| ${d.name} | ${d.files.length} | ${mb(a.bytes)} | ${fmtMs(a.median)} | ${fmtMs(b.median)} | **${x(a.median, b.median)}** | ${ident}/${d.files.length} |`)
    const m = worker({...base, impl: 'markdown-it'}); const k = worker({...base, impl: 'marked'})
    result.parse.at(-1).others = {markdownIt: m, marked: k}
    others.push({d, a, m, k})
  }
  log('')
  log('Other parsers on the same input. Different output: markdown-it returns a token list and marked returns its own token tree, neither is mdast, and neither is a drop-in replacement. Shown for scale only.\n')
  log('| Input | markdown-it `parse` (tokens) | marked `lexer` (tokens) |')
  log('|---|---|---|')
  for (const o of others) log(`| ${o.d.name} | ${fmtMs(o.m.median)} | ${fmtMs(o.k.median)} |`)
  log('')
}

// ---- MDX ----
if (only.includes('mdx')) {
  const sets = datasets(small ? 100 : 16).slice(0, small ? 1 : 3)
  log('### MDX (`@mdx-js/mdx` `compile`)\n')
  log('Plain `format: \'md\'` with `remark-gfm`, default parser versus samemark as the parser. `format: \'mdx\'` loads `micromark-extension-mdxjs`, which is not in the stock GFM set, so samemark falls back there by design; it is measured on the files that are valid MDX to show the overhead is nil. Compiled output is compared.\n')
  log('| Input | Format | Files compiled | default | with samemark | Speedup | Identical output | samemark path |')
  log('|---|---|---|---|---|---|---|---|')
  for (const d of sets) {
    for (const fmt of ['md', 'mdx']) {
      const base = {task: 'mdx', files: d.files, rounds: Math.max(2, Math.floor(rounds / 2)), mdxFormat: fmt}
      const a = worker({...base, impl: 'default'})
      const b = worker({...base, impl: 'samemark'})
      const same = a.valid === b.valid && a.fileHashes.every((h, i) => h === b.fileHashes[i])
      result.mdx.push({dataset: d.name, format: fmt, valid: a.valid, default: a, samemark: b, same})
      if (a.valid === 0) { log(`| ${d.name} | ${fmt} | 0 of ${d.files.length} | n/a | n/a | n/a | n/a | no file in this set is valid MDX |`); continue }
      log(`| ${d.name} | ${fmt} | ${a.valid} of ${d.files.length} | ${fmtMs(a.median)} | ${fmtMs(b.median)} | ${x(a.median, b.median)} | ${same ? 'yes' : 'NO'} | ${b.stats.fast} fast, ${b.stats.fallback} fallback |`)
    }
  }
  log('')
}

// ---- react-markdown ----
if (only.includes('reactmd')) {
  const cfg = small
    ? {lengths: [10000], reps: 5, streams: [{len: 3000, step: 100, runs: 1}]}
    : {lengths: [10000, 30000], reps: 11, streams: [{len: 10000, step: 20, runs: 3}, {len: 30000, step: 20, runs: 3}]}
  const a = worker({task: 'reactmd', impl: 'remark', ...cfg})
  const b = worker({task: 'reactmd', impl: 'samemark', ...cfg})
  const same = a.prefixHashes.filter((h, i) => h === b.prefixHashes[i]).length
  result.reactmd = {remark: a, samemark: b, identicalPrefixes: same, prefixes: a.prefixHashes.length}
  log('### react-markdown (desktop, Node, `renderToStaticMarkup`, React production build)\n')
  log(`react-markdown ${'10.1.0'} builds a new unified processor on every render (\`unified().use(remarkParse).use(remarkPlugins)...\`), so \`remarkPlugins={[remarkParseFast, remarkGfm]}\` replaces its parser on every render. The input is a synthetic chat-style answer (headings, lists, code, tables, links; \`bench/perf/chat-text.mjs\`). Output HTML is compared at ${a.prefixHashes.length} prefix lengths, partial constructs included: ${same}/${a.prefixHashes.length} identical. samemark path: ${b.stats.fast} fast, ${b.stats.fallback} fallback.\n`)
  log('One update at a fixed message length (this is also the cost of rendering a finished long answer):\n')
  log('| Message length | react-markdown default | with samemark | Speedup |')
  log('|---|---|---|---|')
  for (const L of cfg.lengths) log(`| ${L.toLocaleString('en-US')} characters | ${fmtMs(a.fixed[L].medianMs)} | ${fmtMs(b.fixed[L].medianMs)} | **${x(a.fixed[L].medianMs, b.fixed[L].medianMs)}** |`)
  log('')
  log('Streaming simulation: the message grows by a few characters at a time and the whole message is re-rendered after each step, as chat apps do:\n')
  log('| Stream | Updates | default: total / mean / worst update | samemark: total / mean / worst update | Speedup |')
  log('|---|---|---|---|---|')
  for (const st of cfg.streams) {
    const A = a.stream[st.len], B = b.stream[st.len]
    log(`| to ${st.len.toLocaleString('en-US')} characters, ${st.step} per step | ${A.updates} | ${fmtMs(A.totalMs)} / ${fmtMs(A.meanMs)} / ${fmtMs(A.maxMs)} | ${fmtMs(B.totalMs)} / ${fmtMs(B.meanMs)} / ${fmtMs(B.maxMs)} | **${x(A.totalMs, B.totalMs)}** |`)
  }
  log('')
}

if (jsonOut) { fs.mkdirSync(path.dirname(jsonOut), {recursive: true}); fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1)) }
if (mdOut) { fs.mkdirSync(path.dirname(mdOut), {recursive: true}); fs.writeFileSync(mdOut, lines.join('\n') + '\n') }
const bad = (result.e2eContent || []).filter(r => r.identical !== r.files).length + (result.reactmd && result.reactmd.identicalPrefixes !== result.reactmd.prefixes ? 1 : 0) + result.parse.filter(r => r.identical !== r.files).length + result.e2e.filter(r => r.identical !== r.files).length + result.mdx.filter(r => !r.same).length
if (bad) { console.error(`${bad} dataset(s) with non-identical output`); process.exitCode = 1 }
