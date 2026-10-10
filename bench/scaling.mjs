// Scaling guard. Each (case, size) runs in its own child process (under nice, hard timeout) so a
// super-linear case is reported in seconds instead of hanging. Sizes: N/16, N/8, ... doubling up to 2N;
// a case stops as soon as a step takes > STEP_MS.
// usage: node bench/scaling.mjs [--src=../src/block.js] [--only=substring]
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const STEP_MS = 2000       // stop doubling once a step takes longer than this
const NOISE_MS = 8         // ratios are only judged when the larger step takes at least this long
const HARD_TIMEOUT = 20000 // per child process

const self = fileURLToPath(import.meta.url)

if (process.argv[2] === '--worker') {
  // worker: node scaling.mjs --worker <srcPath> <caseName> <n>
  const [, , , srcPath, name, nStr] = process.argv
  const {parse} = await import(srcPath)
  const {cases} = await import('./cases.mjs')
  const input = cases[name].gen(Number(nStr))
  // warm up the JIT for ~250 ms so that fresh-process timings are comparable across sizes
  for (let w = process.hrtime.bigint(), i = 0; i < 40 && Number(process.hrtime.bigint() - w) / 1e6 < 250; i++) parse(input)
  let best = Infinity, spent = 0
  for (let i = 0; i < 9 && spent < 1500; i++) {
    if (global.gc) global.gc()
    const t = process.hrtime.bigint(); parse(input); const d = Number(process.hrtime.bigint() - t) / 1e6
    if (d < best) best = d
    spent += d
  }
  console.log(JSON.stringify({ms: best, bytes: input.length}))
  process.exit(0)
}

const args = process.argv.slice(2)
const srcArg = (args.find(a => a.startsWith('--src=')) || '--src=../src/block.js').slice(6)
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7)
const srcPath = new URL(srcArg, import.meta.url).href
const {cases} = await import('./cases.mjs')

function run(name, n) {
  const r = spawnSync('nice', ['-n', '19', process.execPath, '--expose-gc', '--max-old-space-size=2048', '--min-semi-space-size=256', '--max-semi-space-size=256', self, '--worker', srcPath, name, String(n)], {timeout: HARD_TIMEOUT, encoding: 'utf8'})
  if (r.error || r.status !== 0) return {timeout: true}
  return JSON.parse(r.stdout)
}

// Verdict per case, from the best of two fresh-process measurements per size (when a size takes >= NOISE_MS):
// (1) a consecutive-size ratio >= HARD fails (catastrophic only: a single doubling step on a small CI runner
// can show 3.8 from page faults / GC alone); (2) the MEDIAN log-log slope between consecutive points that took
// >= SLOPE_MIN_MS must stay <= MAX_SLOPE (linear = 1.0, n log n ~ 1.1, quadratic = 2).
const HARD = 5, SLOPE_MIN_MS = 0.5, MAX_SLOPE = 1.5
let fail = 0
for (const [name, {n}] of Object.entries(cases)) {
  if (only && !name.includes(only)) continue
  const sizes = [...new Set([n / 16, n / 8, n / 4, n / 2, n, 2 * n].map(x => Math.max(1, Math.round(x))))]
  const lines = []
  const pts = []
  let prev = null, verdict = 'ok'
  for (const sz of sizes) {
    let r = run(name, sz)
    if (r.timeout) { lines.push(`      N=${String(sz).padStart(7)}   TIMEOUT (> ${HARD_TIMEOUT / 1000}s)`); verdict = 'FAIL'; break }
    let ms = r.ms
    let note = ''
    if (ms >= NOISE_MS) {
      const r2 = run(name, sz)
      if (r2.timeout) { verdict = 'FAIL'; break }
      if (r2.ms < ms) { note = ` (best of 2: ${ms.toFixed(1)} / ${r2.ms.toFixed(1)})`; ms = r2.ms }
    }
    const ratio = prev ? ms / prev : NaN
    lines.push(`      N=${String(sz).padStart(7)} ${ms.toFixed(1).padStart(9)} ms  ratio ${prev ? ratio.toFixed(2) : '  - '}  ${(r.bytes / 1e6 / (ms / 1000)).toFixed(0).padStart(5)} MB/s${note}`)
    if (prev && ratio >= HARD && ms >= NOISE_MS) { verdict = 'FAIL'; pts.push({sz, ms}); break }
    pts.push({sz, ms})
    if (ms > STEP_MS) { if (sz < 2 * n) verdict = verdict === 'ok' ? 'SLOW' : verdict; break }
    prev = ms
  }
  // median of the log-log slopes between consecutive points that took >= SLOPE_MIN_MS: robust to the one
  // cache / GC knee (a single step) that physical machines show, while quadratic behaviour gives ~2 at every step
  const big = pts.filter(p => p.ms >= SLOPE_MIN_MS)
  let slope = NaN
  if (big.length >= 3) {
    const sl = []
    for (let i = 1; i < big.length; i++) sl.push(Math.log(big[i].ms / big[i - 1].ms) / Math.log(big[i].sz / big[i - 1].sz))
    sl.sort((x, y) => x - y)
    slope = sl[(sl.length - 1) >> 1] // lower median
    if (slope > MAX_SLOPE && verdict === 'ok') verdict = 'FAIL'
  }
  if (verdict !== 'ok') fail++
  console.log(`${verdict.padEnd(4)} ${name}   slope ${Number.isNaN(slope) ? 'n/a' : slope.toFixed(2)}`)
  console.log(lines.join('\n'))
}
console.log(fail ? `${fail} case(s) not linear / too slow` : 'all cases scale roughly linearly')
process.exit(fail ? 1 : 0)
