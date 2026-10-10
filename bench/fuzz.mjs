// Differential fuzzer: samemark vs mdast-util-from-markdown + micromark gfm, full trees including positions.
//
//   node bench/fuzz.mjs --mode=regress
//   node bench/fuzz.mjs --mode=exhaustive --maxlen=6 [--shard=0/8] [--suffix=defs|none]
//   node bench/fuzz.mjs --mode=random --count=200000 --maxlen=20 --seed=1 [--alphabet=base|rich] [--suffix=defs]
//   node bench/fuzz.mjs --mode=mutate --count=100000 --seed=1
//   node bench/fuzz.mjs --mode=spec --count=100000 --seed=1
//
// Failures are delta-minimised, de-duplicated and printed as JSON; with --out=file they are also written
// there (CI uploads it). Every input that ever failed belongs in bench/regressions.json.
import fs from 'node:fs'
import path from 'node:path'
import {ref} from './common.mjs'
import {parse} from '../src/block.js'
import {loadDocs} from './corpus.mjs'
import {minimize, diff, setImpl} from './fuzzlib.mjs'
import {refAll} from './refs.mjs'
import {normalizeMatters} from '../src/block.js'

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] === undefined ? true : m[2]] }))
const mode = args.mode || 'random'
const maxlen = Number(args.maxlen || 6)
const count = Number(args.count || 100000)
const seed = Number(args.seed || 1)
const [shard, shards] = (args.shard || '0/1').split('/').map(Number)
const suffixes = {
  none: '',
  defs: '\n\n[a]: /u "t"\n[b]: <v>\n[^a]: note\n',
}
const suffix = suffixes[args.suffix || 'none'] ?? ''
// prefixes make the generated text the title / destination / footnote body of a definition, or put it
// behind a quote / list marker with a footnote definition
const prefixes = {
  none: '',
  def: '[a]: /u\n', defparen: '[a]: /u\n(', defquote: '[a]: /u\n"', defapos: "[a]: /u\n'", defangle: '[a]: <', defdest: '[a]: ',
  deftitle: '[a]: /u "', defspace: '[a]: /u ',
  fmy: '---\n', fmy2: '---\na: 1\n', fmt: '+++\n', fmt2: '+++\ntitle = 1\n+++\n', fmt2: '+++\nb = 1\n', fmcrlf: '---\r\na: 1\r\n', fmsp: '---  \n', fmc1: '<!--\n', fmc2: '~~~\n', fmx: 'x\n---\na\n',
  mathfl: '$$\n', mathfl2: '$$ meta\nx\n', mathbq: '> $$\n> ', mathli: '- $$\n  ', mathp: 'a\n',
  fnbq: '> > a\n> [^1]: x\n> ', fnbq2: '> [^1]: x\n>\n> ', fnli: '- a\n  [^1]: x\n  ', fn: '[^1]: x\n    ',
}
const prefix = prefixes[args.prefix || 'none'] ?? ''
const outFile = args.out
// --ext=frontmatter variants: which matters the reference and samemark are both configured with
const EXT = {
  fm: ['yaml', 'toml'],
  fmy: undefined,
  fmc: [{type: 'yaml', marker: '-'}, {type: 'custom', fence: {open: '<!--', close: '-->'}}, {type: 'plus', fence: '+++'}],
  fmm: [{type: 'a', marker: {open: '~', close: '`'}}, 'yaml'],
}
let refImpl = ref, parseImpl = parse
if (args.ext) {
  // --ext=fm,math : any mix of frontmatter variants (fm fmy fmc fmm) and math (math = $ single, mathns = $$ only)
  const parts = String(args.ext).split(',')
  const fmName = parts.find(x => x in EXT)
  const mathName = parts.find(x => x === 'math' || x === 'mathns')
  const matters = fmName ? EXT[fmName] : undefined
  const mathOpt = mathName === 'mathns' ? {singleDollarTextMath: false} : undefined
  const r = refAll(fmName ? matters : null, mathName ? mathOpt : null, Boolean(fmName), Boolean(mathName))
  const nm = fmName ? normalizeMatters(matters) : undefined
  const popts = {}
  if (fmName) popts.frontmatter = nm
  if (mathName) popts.math = {single: !(mathName === 'mathns')}
  refImpl = r; parseImpl = s => parse(s, popts)
  setImpl(refImpl, parseImpl)
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(seed * 7919 + shard)
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
  for (const k in a) {
    const v = a[k]
    if (v === undefined) continue
    na++
    if (!eq(v, b[k])) return false
  }
  let nb = 0
  for (const k in b) if (b[k] !== undefined) nb++
  return na === nb
}

// documented divergences (KNOWN_GAPS.md): minimised failures listed here are reported but do not fail the run
const knownGaps = new Set(JSON.parse(fs.readFileSync(new URL('./known-gaps.json', import.meta.url), 'utf8')))
let knownCount = 0
let cases = 0
const ring = []
const failures = new Map() // minimised input -> {orig, path}
function check(s) {
  cases++
  if (args.leak) { ring.push(s); if (ring.length > 4000) ring.shift() }
  let a
  try { a = refImpl(s) } catch (e) { return }
  let b, crash = null
  try { b = parseImpl(s) } catch (e) { crash = e }
  if (!crash && eq(a, b)) return
  if (args.leak) {
    // state-leak hunt: which earlier input makes `s` fail?
    for (let i = ring.length - 2; i >= 0; i--) {
      try { parseImpl(ring[i]) } catch {}
      if (!eq(refImpl(s), parseImpl(s))) { console.log('LEAK from', JSON.stringify(ring[i]), 'target', JSON.stringify(s)); break }
    }
  }
  if (failures.size < 60) {
    const m = minimize(s)
    if (knownGaps.has(m)) { knownCount++; return }
    if (!failures.has(m)) failures.set(m, {orig: s, d: (() => { const d = diff(m); return d ? d.path + ' ref=' + JSON.stringify(d.a)?.slice(0, 60) + ' mine=' + JSON.stringify(d.b)?.slice(0, 60) : '' })(), crash: crash ? String(crash.stack).split('\n').slice(0, 3).join(' | ') : null})
  } else failures.set('#' + cases, {orig: s})
}

// ---------------------------------------------------------------- generators
const BASE = ['*', '_', '~', '[', ']', '(', ')', '!', '<', '>', '\\', '`', '&', '"', ' ', '\n', 'a']
// rich: block constructs, links, literals, tables, footnotes, definitions
const RICH_TOKENS = ['$', '$$', '$ ', '*', '**', '***', '_', '__', '~', '~~', '[', ']', '(', ')', '!', '<', '>', '\\', '`', '``', '&', '&amp;', '"', "'", ' ', '  ', '\n', '\n\n', 'a', 'b', 'a_b', 'x*y', ':', '|', '-', '#', '1.', '- ', '> ', '    ', '[x]', '[ ]', '[^a]', '[a]', '[b]', '](a)', '](/u "t")', 'www.a.com', 'http://a.b', 'a@b.co', '<a>', '<!--', '-->', '```', '\t', '=', '+', '.', 'h', 'w', '^', '\\\n', 'é', '😀', '$', '@', '/', '[a]: ', '[^a]: ', '[^1]: x\n    ', '> ', '> > ', '(', "'", '"', '<', '\n(', '\n"', "\n'", '\n<']

// links: label starts / ends / resources / references / definitions / titles / footnotes
const LINK_TOKENS = ['[', ']', '(', ')', '![', '[a]', '[a][b]', '[a][]', '[^1]', '![^1]', '](', '](/u', '](/u "t")', '](<u>)', '[a]: /u', '[b]: /u "t"', '[a]:', '"', "'", '"t"', '(t)', '((', '))', '<', '>', '<http://x.y>', '<a@b.c>', '\\', '\\[', ' ', ' ', '\n', '\n', '\n\n', 'a', 'b', '*', '_', '`', '~~', '&amp;', '[^1]: x', '    ', '> ', '- ', 'www.a.com', '[a](b)', '![a](b)', '[ ]', '\t']
const FM_TOKENS = ['---', '--', '-', '+++', '++', '+', '<!--', '-->', '~~~', '`', '\n', '\n', '\n', '\r\n', '\r', ' ', '\t', 'a', 'a: 1', 'b = 2', '#', '# h', '> ', '- ', '* ', '[x]', '***', '___', '<', '>', '=']
const MATH_TOKENS = ['$', '$$', '$$$', '\\$', '\\', '`', '``', '*', '_', '~~', '[', ']', '(', ')', '!', '<', '>', ' ', '  ', '\n', '\n', '\r\n', 'a', 'x^2', '$$ m', '\t', '- ', '> ', '# ', '    ', '|', '-']
function genRandom(alpha) {
  const len = 1 + ri(maxlen)
  let s = ''
  if (alpha === 'math') {
    for (let i = 0; i < len; i++) s += MATH_TOKENS[ri(MATH_TOKENS.length)]
    return s
  }
  if (alpha === 'fm') {
    for (let i = 0; i < len; i++) s += FM_TOKENS[ri(FM_TOKENS.length)]
    return s
  }
  if (alpha === 'links') {
    for (let i = 0; i < len; i++) s += LINK_TOKENS[ri(LINK_TOKENS.length)]
    return s
  }
  if (alpha === 'rich') {
    for (let i = 0; i < len; i++) s += RICH_TOKENS[ri(RICH_TOKENS.length)]
    return s
  }
  while (s.length < len) {
    const r = rnd()
    if (r < 0.28) { // a run of * or _ (length 1-6)
      const c = rnd() < 0.5 ? '*' : '_'
      s += c.repeat(1 + ri(6))
    } else if (r < 0.34) s += '~'.repeat(1 + ri(3))
    else if (r < 0.40) s += '`'.repeat(1 + ri(3))
    else s += BASE[ri(BASE.length)]
  }
  return s
}

function* exhaustive() {
  const B = BASE.length
  let idx = 0
  for (let len = 1; len <= maxlen; len++) {
    const digits = new Array(len).fill(0)
    for (;;) {
      if (idx++ % shards === shard) {
        let s = ''
        for (let i = 0; i < len; i++) s += BASE[digits[i]]
        yield s
      }
      let p = len - 1
      while (p >= 0 && ++digits[p] === B) { digits[p] = 0; p-- }
      if (p < 0) break
    }
  }
}

// corpus paragraph pool for the mutation fuzzer
function paragraphPool() {
  const files = loadDocs()
  const pool = []
  for (let i = 0; i < files.length && pool.length < 4000; i += 1 + ri(3)) {
    const txt = files[i].src
    for (const p of txt.split(/\n{2,}/)) {
      if (p.length > 8 && p.length <= 400 && /[*_\[`<~!&\\]/.test(p)) pool.push(p)
    }
  }
  return pool
}
const SPECIALS = ['*', '_', '~', '[', ']', '(', ')', '!', '<', '>', '\\', '`', '&', '"', '\n', ' ', '|', ':', '@', '^', '#', '-']
function mutate(p) {
  const k = 1 + ri(2)
  for (let j = 0; j < k; j++) {
    const op = ri(3)
    const pos = ri(p.length + 1)
    if (op === 0) p = p.slice(0, pos) + SPECIALS[ri(SPECIALS.length)] + p.slice(pos)
    else if (op === 1 && p.length > 1) p = p.slice(0, pos) + p.slice(pos + 1)
    else if (p.length > 1) { const q = ri(p.length); const ch = p[q]; p = p.slice(0, pos) + ch + p.slice(pos) }
  }
  return p
}

function specExamples() {
  const specText = fs.readFileSync(new URL('../node_modules/commonmark-spec/spec.txt', import.meta.url), 'utf8')
  const out = []
  const re = /^`{32} example[^\n]*\n([\s\S]*?)^\.\n([\s\S]*?)^`{32}$/gm
  let m
  while ((m = re.exec(specText))) out.push(m[1].replace(/→/g, '\t'))
  return out
}

// ---------------------------------------------------------------- run
const t0 = Date.now()
if (mode === 'regress') {
  const file = new URL(args.ext ? './regressions-fm.json' : './regressions.json', import.meta.url)
  const list = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const s of list) { check(s); check(s + suffixes.defs) }
  // state-leak guard: the same inputs again in reverse order, interleaved with themselves
  for (let i = list.length - 1; i >= 0; i--) { check(list[i]); check(list[(i * 7) % list.length]) }
} else if (mode === 'exhaustive') {
  for (const s of exhaustive()) check(prefix + s + suffix)
} else if (mode === 'random') {
  const alpha = args.alphabet || 'base'
  for (let i = 0; i < count; i++) check(prefix + genRandom(alpha) + suffix)
} else if (mode === 'mutate') {
  const pool = paragraphPool()
  for (let i = 0; i < count; i++) check(prefix + mutate(pool[ri(pool.length)]) + suffix)
} else if (mode === 'spec') {
  const ex = specExamples()
  for (let i = 0; i < count; i++) {
    const r = rnd()
    let s
    if (r < 0.4) s = ex[ri(ex.length)] + ex[ri(ex.length)]            // crossover
    else if (r < 0.7) s = mutate(ex[ri(ex.length)])
    else { // line crossover
      const a = ex[ri(ex.length)].split('\n'), b = ex[ri(ex.length)].split('\n')
      s = a.slice(0, 1 + ri(a.length)).concat(b.slice(ri(b.length))).join('\n')
    }
    check(prefix + s + suffix)
  }
} else { console.error('unknown mode'); process.exit(2) }

const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`fuzz ${mode} ${args.alphabet || ''} ${args.prefix || ''} ${args.suffix || ''} shard ${shard}/${shards} seed ${seed}: ${cases} cases, ${failures.size} failing${knownCount ? ' (+' + knownCount + ' known gaps)' : ''}, ${secs}s`)
if (failures.size) {
  const rows = [...failures.entries()].map(([m, v]) => ({input: m.startsWith('#') ? v.orig : m, orig: v.orig, crash: v.crash, d: v.d}))
  for (const r of rows.slice(0, Number(args.show || 20))) console.log('  FAIL ' + JSON.stringify(r.input) + (r.d ? '  ' + r.d : '') + (r.crash ? ' CRASH ' + r.crash : ''))
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(rows, null, 1))
  process.exit(1)
}
