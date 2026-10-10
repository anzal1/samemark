// Records the streaming demo (site/dist) in headless, muted Chromium and writes a screen capture plus an optimised GIF.
// CI-friendly (the bench is too heavy for a laptop):
//   node site/build.mjs
//   npm i --no-save --no-package-lock playwright@1.64.0 && npx playwright install --with-deps chromium
//   node scripts/record-demo.mjs --out=out [--len=30000] [--rate=100] [--fps=12] [--width=880] [--height=680]
// Needs ffmpeg on the PATH for the GIF. Writes: out/demo.webm, out/demo-stream.gif, out/result.json, out/page-*.png
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

// the recording
const ctx = await browser.newContext({viewport: {width, height}, colorScheme: 'light', recordVideo: {dir: out, size: {width, height}}})
const page = await ctx.newPage()
await page.goto(base + `?len=${len}&rate=${rate}`)
await page.evaluate(() => { const c = document.querySelector('.controls'); window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 12) })
const t0 = Date.now()
await page.waitForFunction(() => window.__samemarkDemo && window.__samemarkDemo.done, null, {timeout: 120000})
const runMs = Date.now() - t0
await page.waitForTimeout(1500)
const result = await page.evaluate(() => ({...window.__samemarkDemo, badge: document.getElementById('badge').textContent}))
await ctx.close()
const video = await page.video().path()
fs.copyFileSync(video, path.join(out, 'demo.webm'))
fs.rmSync(video)
await browser.close()
server.close()
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({chromium: version, len, rate, runMs, ...result}, null, 2))
console.log('run took', runMs, 'ms', JSON.stringify(result))
if (result.mismatches) throw new Error('DOM mismatch in the demo')

// GIF: skip the blank first frames, at most 12 s, one shared palette
const gif = path.join(out, 'demo-stream.gif')
const vf = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.5', '-t', '12', '-i', path.join(out, 'demo.webm'), '-vf', vf, '-loop', '0', gif], {stdio: 'inherit'})
console.log('gif', (fs.statSync(gif).size / 1024 / 1024).toFixed(2), 'MB')
