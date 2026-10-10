// Deep nesting: 10,000-level blockquotes / lists / emphasis / links must not throw (micromark itself throws
// RangeError from 10,000 levels on); at 1,000 levels the trees must be identical to micromark's.
import assert from 'node:assert/strict'
import {parse} from '../src/block.js'
import {ref} from '../bench/common.mjs'

function depth(n) { let d = 0; const st = [[n, 1]]; while (st.length) { const [x, k] = st.pop(); if (k > d) d = k; for (const c of x.children || []) st.push([c, k + 1]) } return d }
function same(a, b) { // iterative structural equality (undefined-valued keys count as absent)
  const st = [[a, b]]
  while (st.length) {
    const [x, y] = st.pop()
    if (x === y) continue
    if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) return false
    const kx = Object.keys(x).filter(k => x[k] !== undefined), ky = Object.keys(y).filter(k => y[k] !== undefined)
    if (kx.length !== ky.length) return false
    for (const k of kx) {
      if (Array.isArray(x[k])) {
        if (!Array.isArray(y[k]) || x[k].length !== y[k].length) return false
        for (let i = 0; i < x[k].length; i++) st.push([x[k][i], y[k][i]])
      } else st.push([x[k], y[k]])
    }
  }
  return true
}
const shapes = {
  blockquotes: [n => '> '.repeat(n) + 'x\n', 1],
  'blockquote rows': [n => Array.from({length: n}, (_, k) => '> '.repeat(k + 1) + 'x').join('\n') + '\n', 1],
  lists: [n => '- '.repeat(n) + 'x\n', 2],
  'indented list rows': [n => Array.from({length: n}, (_, k) => '  '.repeat(k) + '- x').join('\n') + '\n', 2],
  'bq + list': [n => '> - '.repeat(n) + 'x\n', 2],
  emphasis: [n => '*a '.repeat(n) + 'b' + '* '.repeat(n), 0],
  'links in images': [n => '!['.repeat(n) + 'a' + '](u)'.repeat(n), 0],
  'strikethrough': [n => '~~a '.repeat(n) + 'b' + '~~ '.repeat(n), 0],
}
for (const [name, [gen, per]] of Object.entries(shapes)) {
  // 10,000 levels (rows shapes are quadratic in input size: 1,500 rows is enough to prove the point)
  const big = name.includes('rows') ? 1500 : 10000
  const t = parse(gen(big))
  if (per) assert.ok(depth(t) >= big * per, `${name}: expected depth >= ${big * per}, got ${depth(t)}`)
  // 1,000 levels: identical to micromark
  const n = name.includes('rows') ? 250 : 1000
  assert.ok(same(parse(gen(n)), ref(gen(n))), `${name} at ${n} levels differs from micromark`)
}
console.log('depth tests ok')
