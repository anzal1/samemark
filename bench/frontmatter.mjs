// Frontmatter variants over the corpus (and spec examples): the same documents with a yaml / toml / custom
// frontmatter block prepended, unclosed fences, frontmatter not at the start, CRLF.
//   node bench/frontmatter.mjs [--sample=24]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {refAll} from './refs.mjs'
import {firstDiff} from './common.mjs'
import {loadDocs, loadSpecs} from './corpus.mjs'
import {parse, normalizeMatters} from '../src/block.js'

const args = process.argv.slice(2)
const sampleN = Number((args.find(a => a.startsWith('--sample=')) || '').slice(9)) || 0
const docs = loadDocs({sample: sampleN}).map(it => it.src)
const spec = loadSpecs().flatMap(set => set.items.map(it => it.src))

// name -> {matters (undefined = default yaml, null = none), math: undefined | false | {single}}
const configs = {
  'yaml+toml': {matters: ['yaml', 'toml']},
  'yaml (default)': {matters: undefined},
  'custom fences': {matters: [{type: 'yaml', marker: '-'}, {type: 'custom', fence: {open: '<!--', close: '-->'}}, {type: 'plus', fence: '+++'}]},
  'math only': {matters: null, math: {single: true}},
  'math $$ only': {matters: null, math: {single: false}},
  'yaml+toml+math': {matters: ['yaml', 'toml'], math: {single: true}},
}
const variants = {
  asIs: s => s,
  yaml: s => '---\ntitle: x\ntags: [a, b]\n---\n' + s,
  yamlBlank: s => '---\n---\n\n' + s,
  yamlSpace: s => '---  \ntitle: x\n---\t\n' + s,
  toml: s => '+++\ntitle = "x"\n+++\n' + s,
  html: s => '<!--\nmeta\n-->\n' + s,
  unclosed: s => '---\ntitle: x\n' + s,
  unclosedToml: s => '+++\ntitle = "x"\n' + s,
  notAtStart: s => '\n---\ntitle: x\n---\n' + s,
  indented: s => ' ---\ntitle: x\n---\n' + s,
  crlf: s => ('---\ntitle: x\n---\n' + s).replace(/\r?\n/g, '\r\n'),
  cr: s => ('---\ntitle: x\n---\n' + s).replace(/\r?\n/g, '\r'),
  twice: s => '---\na: 1\n---\n---\nb: 2\n---\n' + s,
  fenceLookalike: s => '----\ntitle: x\n----\n' + s,
  closeInContent: s => '---\na\n---\n' + s + '\n---\nlate\n---\n',
}
let total = 0, bad = 0
const shown = new Map()
for (const [cname, cfg] of Object.entries(configs)) {
  const hasFm = cfg.matters !== null, hasMath = Boolean(cfg.math)
  const ref = refAll(cfg.matters, hasMath && cfg.math.single === false ? {singleDollarTextMath: false} : undefined, hasFm, hasMath)
  const popts = {}
  if (hasFm) popts.frontmatter = normalizeMatters(cfg.matters)
  if (hasMath) popts.math = cfg.math
  for (const [vname, v] of Object.entries(variants)) {
    let n = 0, ok = 0
    for (const d of docs.concat(spec)) {
      const s = v(d)
      let a; try { a = ref(s) } catch { continue }
      n++
      let b; try { b = parse(s, popts) } catch (e) { b = null }
      const df = b === null ? {path: 'CRASH'} : firstDiff(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
      if (!df) ok++
      else if (!shown.has(cname + vname)) shown.set(cname + vname, JSON.stringify(s.slice(0, 80)) + ' ' + df.path)
    }
    total += n; bad += n - ok
    if (ok !== n || !args.includes('--quiet')) console.log(`${cname.padEnd(15)} ${vname.padEnd(15)} ${ok}/${n}`)
  }
}
console.log(`frontmatter variants: ${total - bad}/${total} identical`)
for (const [k, v] of shown) console.log('  MISS', k, v)
process.exit(bad ? 1 : 0)
