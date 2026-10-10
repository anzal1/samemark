// Differential helpers: compare samemark against micromark, delta-minimize failures.
import {ref, firstDiff} from './common.mjs'
import {parse} from '../src/block.js'

let refFn = ref, parseFn = parse
// swap the implementations under test (e.g. with the frontmatter extension)
export function setImpl(r, p) { refFn = r; parseFn = p }

export function diff(s) {
  let a
  try { a = refFn(s) } catch (e) { return null }
  let b
  try { b = parseFn(s) } catch (e) { return {path: 'CRASH', a: null, b: String(e.message).slice(0, 80)} }
  return firstDiff(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
}

// greedy ddmin: remove chunks of decreasing size while the input still differs
export function minimize(s) {
  if (!diff(s)) return s
  let size = Math.max(1, s.length >> 1)
  while (size >= 1) {
    let changed = false
    for (let i = 0; i + size <= s.length;) {
      const t = s.slice(0, i) + s.slice(i + size)
      if (t.length > 0 && diff(t)) { s = t; changed = true } else i += size
    }
    if (!changed) size >>= 1
  }
  return s
}
