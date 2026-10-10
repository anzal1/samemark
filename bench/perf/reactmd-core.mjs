// Shared by the Node worker and the browser page: measures react-markdown renders of a growing chat message.
// `render(text)` must return the HTML string (so outputs can be compared between the two parsers).
import {chatAnswer} from './chat-text.mjs'

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const fnv = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(16) + ':' + s.length }

export function measure({render, lengths = [10000, 30000], reps = 11, streams = [{len: 10000, step: 20, runs: 3}, {len: 30000, step: 20, runs: 3}], verifyStep = 250, gc = () => {}}) {
  const text = chatAnswer(Math.max(...lengths, ...streams.map(s => s.len)))
  const out = {textChars: text.length}
  // identity: HTML at every verifyStep-th prefix (partial constructs included), not timed
  out.prefixHashes = []
  for (let n = verifyStep; n <= text.length; n += verifyStep) out.prefixHashes.push(fnv(render(text.slice(0, n))))
  // (a) one update at a fixed message length: this is also the cost of rendering a finished long answer
  out.fixed = {}
  for (const L of lengths) {
    const prefix = text.slice(0, L)
    for (let i = 0; i < 3; i++) render(prefix)
    const times = []
    for (let i = 0; i < reps; i++) { gc(); const t0 = performance.now(); render(prefix); times.push(performance.now() - t0) }
    out.fixed[L] = {medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times), reps}
  }
  // (b) streaming: re-render the whole message after every `step` new characters
  out.stream = {}
  for (const {len, step, runs} of streams) {
    const totals = [], means = [], maxes = []
    for (let r = 0; r < runs; r++) {
      gc()
      let total = 0, max = 0, n = 0
      for (let end = step; end <= len; end += step) {
        const t0 = performance.now(); render(text.slice(0, end)); const dt = performance.now() - t0
        total += dt; if (dt > max) max = dt; n++
      }
      totals.push(total); means.push(total / n); maxes.push(max)
      out.stream[len] = {updates: n, step}
    }
    Object.assign(out.stream[len], {totalMs: median(totals), meanMs: median(means), maxMs: median(maxes), runs})
  }
  return out
}
