import fs from 'node:fs'
import path from 'node:path'
import {fromMarkdown} from 'mdast-util-from-markdown'
import crypto from 'node:crypto'
import {ref, firstDiff} from './common.mjs'
import {parse} from '../src/block.js'
import {loadDocs, loadSpecs} from './corpus.mjs'

const args = process.argv.slice(2)
const noSpeed = args.includes('--nospeed')
const noSpec = args.includes('--nospec')
const limit = Number((args.find(a => a.startsWith('--limit=')) || '').slice(8)) || Infinity
const sampleN = Number((args.find(a => a.startsWith('--sample=')) || '').slice(9)) || 0
const hashMod = (name, N) => crypto.createHash('md5').update(name).digest().readUInt32BE(0) % N
const withReadme = args.includes('--readme')
const items = loadDocs({sample: sampleN, readme: withReadme, requireDocs: args.includes('--require-docs')}).slice(0, limit)
const files = items
const srcs = items.map(i => i.src)
const totalBytes = srcs.reduce((a, s) => a + Buffer.byteLength(s), 0)

function nodeAt(tree, p) { // follow path like .children[2].children[0].type
  let n = tree
  const re = /\.children\[(\d+)\]/g
  let m, last = 0
  while ((m = re.exec(p))) { n = n.children[Number(m[1])]; last = re.lastIndex }
  return {n, rest: p.slice(last)}
}

function classify(a, b, d) {
  // a=ref b=mine
  const {n, rest} = nodeAt(a, d.path)
  const nb = nodeAt(b, d.path).n
  const t = n ? n.type : '?'
  let field = rest.replace(/\[\d+\]/g, '[]')
  if (d.lenA !== undefined) return `${t}: children count (${field}) ref=${d.lenA} mine=${d.lenB}`
  return `${t}${field}`
}

function runCompare(name, items) {
  let ok = 0
  const classes = new Map()
  const crashes = []
  for (const it of items) {
    let ra, mb
    try { ra = ref(it.src) } catch (e) { continue }
    try { mb = parse(it.src) } catch (e) { crashes.push({id: it.id, e}); classes.set('CRASH ' + String(e.message).slice(0, 60), (classes.get('CRASH ' + String(e.message).slice(0, 60)) || {n: 0, ex: it}) ); classes.get('CRASH ' + String(e.message).slice(0, 60)).n++; continue }
    const d = firstDiff(JSON.parse(JSON.stringify(ra)), JSON.parse(JSON.stringify(mb)))
    if (!d) { ok++; continue }
    const cls = classify(ra, mb, d)
    const c = classes.get(cls)
    if (c) c.n++; else classes.set(cls, {n: 1, ex: it, d})
  }
  return {ok, total: items.length, classes, crashes}
}

const r = runCompare('corpus', items)
let exitCode = 0
console.log(`corpus: ${files.length} files (${withReadme ? 'docs + synthetic + README corpus' : 'docs + synthetic'}), ${(totalBytes / 1e6).toFixed(2)} MB`)
console.log(`full-tree identical: ${r.ok}/${r.total} = ${(100 * r.ok / r.total).toFixed(2)}%`)
if (r.ok !== r.total) exitCode = 1
const summary = [`corpus identity: ${r.ok}/${r.total} = ${(100 * r.ok / r.total).toFixed(2)}%`]
const top = [...r.classes.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15)
console.log('top mismatch classes:')
for (const [k, v] of top) {
  console.log(`  ${v.n}\t${k}\t(${v.ex.id}) path=${v.d ? v.d.path : ''} ref=${JSON.stringify(v.d && v.d.a)?.slice(0, 120)} mine=${JSON.stringify(v.d && v.d.b)?.slice(0, 120)}`)
}
if (r.crashes.length) console.log('first crash:', r.crashes[0].id, r.crashes[0].e.stack.split('\n').slice(0, 4).join('\n'))

if (!noSpec) {
  for (const set of loadSpecs()) {
    const sr = runCompare(set.name, set.items)
    console.log(`${set.name} spec full-tree pass: ${sr.ok}/${sr.total} = ${(100 * sr.ok / sr.total).toFixed(1)}%`)
    if (sr.ok !== sr.total) exitCode = 1
    summary.push(`${set.name} spec identity: ${sr.ok}/${sr.total}`)
    const st = [...sr.classes.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)
    for (const [k, v] of st) console.log(`  ${v.n}\t${k}\t(${v.ex.id})`)
    fs.writeFileSync(new URL('../spec-fails.json', import.meta.url), JSON.stringify([...sr.classes.values()].map(v => v.ex.id)))
  }
}

if (!noSpeed) {
  function median(a) { a = [...a].sort((x, y) => x - y); return a[a.length >> 1] }
  const t = (fn) => { const s = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - s) / 1e9 }
  const mine = () => { for (const s of srcs) parse(s) }
  mine(); mine()
  const tm = []; for (let i = 0; i < 5; i++) tm.push(t(mine))
  const mbps = totalBytes / 1e6 / median(tm)
  const ref0 = () => { for (const s of srcs) ref(s) }
  ref0()
  const tr = []; for (let i = 0; i < 3; i++) tr.push(t(ref0))
  const rbps = totalBytes / 1e6 / median(tr)
  console.log(`samemark: ${mbps.toFixed(1)} MB/s   micromark+gfm: ${rbps.toFixed(2)} MB/s   (${(mbps / rbps).toFixed(0)}x)`)
  summary.push(`full parse: ${mbps.toFixed(1)} MB/s vs micromark+gfm ${rbps.toFixed(2)} MB/s (${(mbps / rbps).toFixed(0)}x)`)
}
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### corpus + spec\n\n' + summary.map(x => '- ' + x).join('\n') + '\n')
process.exit(exitCode)
