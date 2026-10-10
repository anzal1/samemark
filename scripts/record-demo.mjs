// Captures the streaming demo (site/dist) in headless, muted Chromium (screenshots during the run) and writes an optimised GIF.
// CI-friendly (the bench is too heavy for a laptop):
//   node site/build.mjs
//   npm i --no-save --no-package-lock playwright@1.64.0 && npx playwright install --with-deps chromium
//   node scripts/record-demo.mjs --out=out [--len=30000] [--rate=100] [--width=880] [--height=680]
// Needs ffmpeg on the PATH for the GIF. Writes: out/frames/*.png, out/demo-stream.gif, out/result.json, out/page-*.png
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {chromium} from 'playwright'

const arg = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const root = path.resolve(new URL('..', import.meta.url).pathname)
const dist = path.join(root, 'site/dist')
const out = path.resolve(arg('out', 'out'))
const len = arg('len', '30000'), rate = arg('rate', '100'), fps = Number(arg('fps', '12'))
const width = Number(arg('width', '880')), height = Number(arg('height', '680'))
fs.mkdirSync(out, {recursive: true})

const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css'}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
  if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, {'content-type': types[path.extname(file)] || 'application/octet-stream'})
  fs.createReadStream(file).pipe(res)
}).listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({args: ['--mute-audio']})
const version = browser.version()

// full page screenshots (light, dark, phone) of the finished page, for review
for (const [name, opts] of [['desktop-light', {viewport: {width: 1100, height: 900}, colorScheme: 'light'}], ['desktop-dark', {viewport: {width: 1100, height: 900}, colorScheme: 'dark'}], ['phone-dark', {viewport: {width: 390, height: 844}, colorScheme: 'dark', isMobile: true, deviceScaleFactor: 2}]]) {
  const ctx = await browser.newContext(opts)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(base + '?len=10000&rate=0')
  await page.waitForFunction(() => window.__samemarkDemo && window.__samemarkDemo.done, null, {timeout: 120000})
  await page.screenshot({path: path.join(out, `page-${name}.png`), fullPage: true})
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  console.log(name, 'horizontal overflow px:', overflow, 'errors:', errors.length)
  if (errors.length) throw new Error(errors.join('\n'))
  await ctx.close()
}

// the capture: lossless screenshots of the page while the run is going (a compressed screen video is noisy and makes a
// GIF several times larger), each with its timestamp; the GIF plays them at the times they were taken
const frames = path.join(out, 'frames')
fs.rmSync(frames, {recursive: true, force: true})
fs.mkdirSync(frames)
const ctx = await browser.newContext({viewport: {width, height}, colorScheme: 'light'})
const page = await ctx.newPage()
await page.goto(base + `?len=${len}&rate=${rate}`)
await page.evaluate(() => { const c = document.querySelector('.controls'); window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 12) })
const t0 = Date.now()
const shots = []
const limit = 11000
for (let i = 0; ; i++) {
  const t = Date.now() - t0
  await page.screenshot({path: path.join(frames, `f${String(i).padStart(4, '0')}.png`)})
  shots.push(t)
  const done = await page.evaluate(() => window.__samemarkDemo.done)
  if (done || Date.now() - t0 > limit) break
}
await page.waitForFunction(() => window.__samemarkDemo.done, null, {timeout: 120000})
const runMs = Date.now() - t0
const result = await page.evaluate(() => ({...window.__samemarkDemo, badge: document.getElementById('badge').textContent}))
// final state, held for 1.5 s
await page.screenshot({path: path.join(frames, `f${String(shots.length).padStart(4, '0')}.png`)})
shots.push(Date.now() - t0)
await ctx.close()
await browser.close()
server.close()
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({chromium: version, len, rate, runMs, frames: shots.length, ...result}, null, 2))
console.log('run took', runMs, 'ms,', shots.length, 'frames', JSON.stringify(result))
if (result.mismatches) throw new Error('DOM mismatch in the demo')

// GIF (screenshots can differ in pixel format, rgb24 against rgba; -reinit_filter 0 plus format=rgb24 keeps one filter
// graph, otherwise ffmpeg restarts the palette pass mid-stream and silently drops most frames): for each output tick pick the latest screenshot taken at or before it (uniform frame times keep the encode
// predictable), hold the final state for 1.5 s, and try settings from richest to leanest; keep the first under budget
const budget = Number(arg('budget', String(2.8 * 1024 * 1024)))
const gif = path.join(out, 'demo-stream.gif')
const name = i => `frames/f${String(i).padStart(4, '0')}.png`
const lastRun = shots[shots.length - 2] // time of the last frame taken before the final one
let best = null
for (const [f, colors, dither] of [[8, 64, 'none'], [7, 64, 'none'], [6, 64, 'none'], [5, 64, 'none'], [5, 48, 'none']]) {
  const dt = 1000 / f
  const list = []
  let j = 0
  for (let t = 0; t <= lastRun; t += dt) {
    while (j + 1 < shots.length - 1 && shots[j + 1] <= t) j++
    list.push(`file '${name(j)}'`, `duration ${(dt / 1000).toFixed(4)}`)
  }
  for (let k = 0; k < Math.round(1500 / dt); k++) list.push(`file '${name(shots.length - 1)}'`, `duration ${(dt / 1000).toFixed(4)}`)
  list.push(`file '${name(shots.length - 1)}'`)
  const listFile = path.join(out, `frames-${f}.txt`)
  fs.writeFileSync(listFile, list.join('\n') + '\n')
  const tmp = path.join(out, `try-${f}fps-${colors}c.gif`)
  const vf = `format=rgb24,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', vf, '-loop', '0', tmp], {stdio: 'inherit'})
  const size = fs.statSync(tmp).size
  console.log(`gif ${f} fps, ${colors} colors: ${(size / 1024 / 1024).toFixed(2)} MB, ${list.length / 2 | 0} frames`)
  if (!best || size < best.size) best = {tmp, size}
  if (size <= budget) { best = {tmp, size}; break }
}
fs.copyFileSync(best.tmp, gif)
console.log('gif', (best.size / 1024 / 1024).toFixed(2), 'MB')
