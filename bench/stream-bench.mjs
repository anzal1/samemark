// Streaming benchmark: an LLM-style answer (headings, paragraphs with emphasis / code / links, bullet and numbered lists,
// a table, fenced code blocks, reference links with definitions at the end) is delivered in small chunks. Compared per run:
//   full re-parse on every push (what chat UIs do) vs createStreamParser.
//   node bench/stream-bench.mjs [--sizes=10000,30000,100000] [--chunk=12] [--micromark]
import {createStreamParser} from '../src/stream.js'
import {parse} from '../src/block.js'

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] === undefined ? true : m[2]] }))
const sizes = (args.sizes || '10000,30000,100000').split(',').map(Number)
const chunk = Number(args.chunk || 12)
const maxFull = Number(args.maxfull || 1e9)

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const words = 'the quick model response streams tokens while the interface keeps rendering markdown for every update of the answer and users read along without waiting for completion of generation'.split(' ')
function sentence(r) { let s = ''; const n = 8 + Math.floor(r() * 14); for (let i = 0; i < n; i++) { let w = words[Math.floor(r() * words.length)]; const k = r(); if (k < 0.04) w = '**' + w + '**'; else if (k < 0.08) w = '*' + w + '*'; else if (k < 0.12) w = '`' + w + '()`'; else if (k < 0.15) w = '[' + w + '](https://example.com/' + w + ')'; else if (k < 0.17) w = '[' + w + '][ref' + Math.floor(r() * 5) + ']'; else if (k < 0.18) w = '[' + Math.floor(1 + r() * 9) + ']'; s += (i ? ' ' : '') + w } return s.charAt(0).toUpperCase() + s.slice(1) + '.' }
function answer(len, seed = 7) {
  const r = mulberry32(seed)
  let out = ''
  let n = 0
  while (out.length < len) {
    const k = r()
    if (k < 0.12) out += '## ' + sentence(r).slice(0, 40) + '\n\n'
    else if (k < 0.5) out += sentence(r) + ' ' + sentence(r) + '\n\n'
    else if (k < 0.65) { const m = 3 + Math.floor(r() * 5); for (let i = 0; i < m; i++) out += '- ' + sentence(r) + '\n'; out += '\n' }
    else if (k < 0.75) { const m = 3 + Math.floor(r() * 4); for (let i = 0; i < m; i++) out += (i + 1) + '. ' + sentence(r) + '\n\n' }
    else if (k < 0.85) { out += '| name | value | note |\n| --- | ---: | :-- |\n'; const m = 3 + Math.floor(r() * 4); for (let i = 0; i < m; i++) out += '| item ' + i + ' | ' + Math.floor(r() * 1000) + ' | `x` ' + words[Math.floor(r() * words.length)] + ' |\n'; out += '\n' }
    else { out += '```js\n'; const m = 4 + Math.floor(r() * 12); for (let i = 0; i < m; i++) out += (i % 5 === 4 ? '\n' : '') + 'const v' + i + ' = compute(' + i + ', "' + words[Math.floor(r() * words.length)] + '")\n'; out += '```\n\n' }
    n++
  }
  out += '[ref0]: https://example.com/0\n[ref1]: https://example.com/1 "one"\n[ref2]: https://example.com/2\n[ref3]: https://example.com/3\n[ref4]: https://example.com/4\n'
  return out
}
const ms = () => Number(process.hrtime.bigint()) / 1e6
function pct(a, p) { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))] }

console.log(`chunk ${chunk} chars per push`)
console.log('chars     pushes   full re-parse: total  per push (p50 / p99 / max)      stream: total  per push (p50 / p99 / max)   speedup')
for (const len of sizes) {
  const text = answer(len)
  if (args.show) { console.log(text.slice(0, 1500)); console.log(JSON.stringify(parse(text)).length, 'json chars,', parse(text).children.length, 'top-level nodes') }
  const chunks = []
  for (let i = 0; i < text.length; i += chunk) chunks.push(text.slice(i, i + chunk))
  // full re-parse per push
  let fullTotal = NaN, fullTimes = []
  if (text.length <= maxFull) {
    let acc = ''
    fullTimes = new Array(chunks.length)
    const t0 = ms()
    for (let i = 0; i < chunks.length; i++) { const a = ms(); acc += chunks[i]; parse(acc); fullTimes[i] = ms() - a }
    fullTotal = ms() - t0
  }
  // stream parser
  const sp = createStreamParser({})
  const times = new Array(chunks.length)
  const t1 = ms()
  let last
  for (let i = 0; i < chunks.length; i++) { const a = ms(); last = sp.push(chunks[i]); times[i] = ms() - a }
  const total = ms() - t1
  // sanity: the final tree is identical to a full parse
  const same = JSON.stringify(last) === JSON.stringify(parse(text))
  const f = x => x.toFixed(3).padStart(8)
  console.log(`${String(text.length).padEnd(9)} ${String(chunks.length).padEnd(8)} ${Number.isNaN(fullTotal) ? '(skipped)'.padStart(14) : (fullTotal.toFixed(0) + ' ms').padStart(14)}  ${fullTimes.length ? f(pct(fullTimes, 0.5)) + f(pct(fullTimes, 0.99)) + f(Math.max(...fullTimes)) : ''}      ${(total.toFixed(0) + ' ms').padStart(8)}  ${f(pct(times, 0.5))}${f(pct(times, 0.99))}${f(Math.max(...times))}   ${Number.isNaN(fullTotal) ? '' : (fullTotal / total).toFixed(1) + 'x'}${same ? '' : '  MISMATCH'}`)
}
