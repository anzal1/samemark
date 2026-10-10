// Stream-differential harness: replay documents through createStreamParser in many chunkings and assert, after EVERY
// push, that the returned tree deep-equals parse(everything pushed so far) (positions included).
//
//   node bench/stream-diff.mjs --mode=corpus [--shard=0/8] [--sample=24] [--maxbytes=20000] [--opts=none|fm|math]
//   node bench/stream-diff.mjs --mode=fuzz --count=2000 --seed=1 [--alphabet=base|rich|links|fm|math] [--opts=...]
//   node bench/stream-diff.mjs --mode=regress
//
// Chunkings: one char, random 1-20, token-like (split before/after spaces and punctuation), whole lines, random with
// CRLF splits and astral characters cut in the middle. Failures are reduced (chunks, then characters) and printed as JSON;
// every input that ever failed belongs in bench/regressions-stream.json (run by --mode=regress on every push).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {createStreamParser} from '../src/stream.js'
import {loadDocs} from './corpus.mjs'
import {parse, normalizeMatters} from '../src/block.js'

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] === undefined ? true : m[2]] }))
const mode = args.mode || 'corpus'
const seed = Number(args.seed || 1)
const [shard, shards] = (args.shard || '0/1').split('/').map(Number)
const OPTS = {
  none: {},
  fm: {frontmatter: ['yaml', 'toml']},
  math: {math: {single: true}},
  all: {frontmatter: ['yaml', 'toml'], math: {single: true}},
}
const optName = args.opts || 'none'
function optsFor(name) {
  const o = OPTS[name]
  const parseOpts = {}, streamOpts = {}
  if (o.frontmatter) { streamOpts.frontmatter = o.frontmatter; parseOpts.frontmatter = normalizeMatters(o.frontmatter) }
  if (o.math) { streamOpts.math = o.math; parseOpts.math = o.math }
  return {parseOpts, streamOpts}
}

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const rnd = mulberry32(seed * 104729 + shard)
const ri = n => Math.floor(rnd() * n)

function eq(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  let na = 0
  for (const k in a) { const v = a[k]; if (v === undefined) continue; na++; if (!eq(v, b[k])) return false }
  let nb = 0
  for (const k in b) if (b[k] !== undefined) nb++
  return na === nb
}
function firstDiff(a, b, p = '') {
  if (a === b) return null
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return {path: p, a, b}
  if (Array.isArray(a) !== Array.isArray(b)) return {path: p, a, b}
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) return {path: p + '[' + i + ']', a: a[i], b: b[i]}
      const d = firstDiff(a[i], b[i], p + '[' + i + ']'); if (d) return d
    }
    return null
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], p + '.' + k); if (d) return d }
  return null
}

// ---------------------------------------------------------------- chunkers
function chunksChars(s) { return Array.from(s.length ? {length: s.length} : [], (_, i) => s[i]) }
function chunksRandom(s, max = 20) { const o = []; for (let i = 0; i < s.length;) { const n = 1 + ri(max); o.push(s.slice(i, i + n)); i += n } return o }
function chunksTokens(s) { return s.match(/[A-Za-z0-9_]+|\r\n|[\s\S]/g) || [] }
function chunksLines(s) { return s.match(/[^\n]*\n|[^\n]+/g) || [] }
function chunksLinesSplit(s) { // lines, each cut once at a random place (CRLF can be cut between CR and LF)
  const o = []
  for (const l of chunksLines(s)) { if (l.length > 1 && rnd() < 0.5) { const k = 1 + ri(l.length - 1); o.push(l.slice(0, k), l.slice(k)) } else o.push(l) }
  return o
}
// cap the number of pushes of big documents (the reference side re-parses everything after every push)
function coarsen(chunks, target = 500) {
  if (chunks.length <= target) return chunks
  const k = Math.ceil(chunks.length / target), o = []
  for (let i = 0; i < chunks.length; i += k) o.push(chunks.slice(i, i + k).join(''))
  return o
}
const STRATEGIES = {chars: chunksChars, random: chunksRandom, tokens: chunksTokens, lines: chunksLines, linesSplit: chunksLinesSplit}

// ---------------------------------------------------------------- the check
let pushes = 0
// returns null or {at, acc, path, a, b}
function streamFails(chunks, optionName) {
  const {parseOpts, streamOpts} = optsFor(optionName)
  const sp = createStreamParser(streamOpts)
  let acc = ''
  for (let i = 0; i < chunks.length; i++) {
    acc += chunks[i]
    let t, r
    try { t = sp.push(chunks[i]) } catch (e) { return {at: i, acc, path: 'THROW', a: String(e.stack).split('\n').slice(0, 3).join(' | '), b: ''} }
    r = parse(acc, parseOpts)
    pushes++
    if (!eq(t, r)) { const d = firstDiff(JSON.parse(JSON.stringify(t)), JSON.parse(JSON.stringify(r))) || {path: '?'}; return {at: i, acc, path: d.path, a: d.a, b: d.b} }
  }
  return null
}

function minimizeStream(chunks, optionName) {
  const f0 = streamFails(chunks, optionName)
  if (!f0) return chunks
  chunks = chunks.slice(0, f0.at + 1)
  // remove chunks
  let size = Math.max(1, chunks.length >> 1)
  while (size >= 1) {
    let ch = false
    for (let i = 0; i + size <= chunks.length;) {
      const t = chunks.slice(0, i).concat(chunks.slice(i + size))
      if (t.length && streamFails(t, optionName)) { chunks = t; ch = true } else i += size
    }
    if (!ch) size >>= 1
  }
  // remove characters inside chunks
  for (let i = 0; i < chunks.length; i++) {
    for (let j = chunks[i].length - 1; j >= 0; j--) {
      const t = chunks.slice(); t[i] = t[i].slice(0, j) + t[i].slice(j + 1)
      if (streamFails(t, optionName)) chunks = t
    }
  }
  return chunks.filter(c => c.length)
}

const failures = []
function report(label, chunks, optionName) {
  const m = minimizeStream(chunks, optionName)
  const f = streamFails(m, optionName)
  failures.push({label, opts: optionName, chunks: m, path: f && f.path})
  console.log('  FAIL', label, optionName, JSON.stringify(m), f ? f.path + ' stream=' + JSON.stringify(f.a)?.slice(0, 60) + ' full=' + JSON.stringify(f.b)?.slice(0, 60) : '')
}
function run(label, chunks, optionName) {
  const f = streamFails(chunks, optionName)
  if (f) { report(label, chunks, optionName); return false }
  return true
}

// ---------------------------------------------------------------- fuzz alphabets
const TOKENS = {
  base: ['*', '_', '~', '[', ']', '(', ')', '!', '<', '>', '\\', '`', '&', '"', ' ', '\n', '\n\n', 'a', 'ab', ':', '#', '-', '- ', '> ', '1. ', '    '],
  rich: ['*', '**', '_', '~~', '[', ']', '(', ')', '!', '<', '>', '\\', '`', '```', '&amp;', '"', ' ', '\n', '\n', '\n\n', '\n\n', 'a', 'word', 'a_b', ':', '|', '-', '---', '#', '## ', '- ', '* ', '> ', '1. ', '    ', '\t', '[x]', '[ ]', '[a]', '[a]:', '[a]: /u', '[^a]', '[^a]: n', '](u)', '](/u "t")', 'www.a.com', 'a@b.co', '<b>', '<!--', '-->', '=', '===', '+++', '$$', '$', '\r\n', '\r', 'é', '😀', '|---|'],
  links: ['[', ']', '(', ')', '![', '[a]', '[b]', '[a][b]', '[a][]', '[^1]', '](/u)', '[a]: /u', '[b]: /v "t"', '[a]:', '\n', '\n\n', '\n\n', ' ', 'a', 'b', '*', '_', '`', '[^1]: x', '> ', '- ', '    ', '<http://x.y>'],
  fm: ['---', '+++', '--', '\n', '\n', '\n\n', '\r\n', ' ', 'a', 'a: 1', '# h', '- ', '> ', '[a]', '[a]: /u', '```', '---\n', '+++\n'],
  math: ['$', '$$', '$$\n', '\n', '\n\n', '\n\n', ' ', 'a', 'x^2', '`', '*', '[', ']', '- ', '> ', '    ', '\\$', '[a]', '[a]: /u'],
}
function genDoc(alpha, maxTokens) {
  const t = TOKENS[alpha]
  const n = 2 + ri(maxTokens)
  let s = ''
  for (let i = 0; i < n; i++) s += t[ri(t.length)]
  return s
}

// ---------------------------------------------------------------- modes
const t0 = Date.now()
let docs = 0
if (mode === 'regress') {
  const list = JSON.parse(fs.readFileSync(new URL('./regressions-stream.json', import.meta.url), 'utf8'))
  for (const r of list) {
    docs++
    for (const o of (r.opts ? [r.opts] : Object.keys(OPTS))) run('regress', r.chunks, o)
  }
} else if (mode === 'corpus') {
  const sampleN = Number(args.sample || 0)
  const maxBytes = Number(args.maxbytes || 20000)
  const items = loadDocs({sample: sampleN, readme: Boolean(args.readme)}).filter((it, i) => i % shards === shard)
  for (const {id: f, src: s} of items) {
    docs++
    const small = s.length <= maxBytes
    const strategies = small ? ['chars', 'random', 'tokens', 'lines', 'linesSplit'] : ['random', 'lines', 'linesSplit']
    for (const st of strategies) {
      if (st === 'chars' && s.length > 6000) { // 1-char replay is quadratic in the reference: only the first part
        run(f + ' chars(prefix)', STRATEGIES.chars(s.slice(0, 3000)), optName)
        continue
      }
      const big = s.length > maxBytes
      let ch = st === 'random' ? chunksRandom(s, 1 + ri(big ? Math.max(40, s.length >> 8) : 40)) : STRATEGIES[st](s)
      if (big || st === 'chars') ch = coarsen(ch, big ? 400 : 6000)
      run(f + ' ' + st, ch, optName)
    }
  }
} else if (mode === 'fuzz') {
  const count = Number(args.count || 1000)
  const alpha = args.alphabet || 'rich'
  for (let i = 0; i < count; i++) {
    const s = genDoc(alpha, Number(args.maxtokens || 40))
    docs++
    const st = ['chars', 'random', 'tokens', 'lines', 'linesSplit'][ri(5)]
    const o = args.opts ? optName : ['none', 'none', 'fm', 'math', 'all'][ri(5)]
    run(`fuzz#${i} ${st}`, STRATEGIES[st](s), o)
  }
} else { console.error('unknown mode'); process.exit(2) }

console.log(`stream-diff ${mode} ${optName}: ${docs} documents, ${pushes} pushes each compared with a full parse, ${failures.length} failing, ${((Date.now() - t0) / 1000).toFixed(1)}s`)
if (args.out && failures.length) fs.writeFileSync(args.out, JSON.stringify(failures, null, 1))
if (failures.length) process.exit(1)
