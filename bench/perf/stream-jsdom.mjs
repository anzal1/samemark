// Streaming a chat message into a DOM, laptop sized: React 19 + jsdom (a real React render and DOM commit per push, no
// layout or paint). Each variant runs in its own process. The Chromium version with CPU throttling is
// bench/perf/reactmd-browser.mjs (CI).
//   node bench/perf/stream-jsdom.mjs [--len=30000] [--step=200]
import {spawnSync} from 'node:child_process'
import {JSDOM} from 'jsdom'
import {build} from 'esbuild'

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a.slice(2), true] }))
const len = Number(args.len || 30000), step = Number(args.step || 200)
const fmt = ms => (ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(ms < 10 ? 1 : 0) + ' ms')

if (!args.impl) {
  const rows = []
  for (const impl of ['remark', 'samemark', 'stream']) {
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, `--impl=${impl}`, `--len=${len}`, `--step=${step}`], {encoding: 'utf8', maxBuffer: 1 << 26})
    if (r.status !== 0) throw new Error(r.stderr)
    rows.push(JSON.parse(r.stdout.trim().split('\n').pop()))
  }
  const base = rows[0]
  const labels = {remark: '(a) react-markdown, whole message per push', samemark: '(b) react-markdown + samemark', stream: '(c) stream parser + memoised blocks'}
  console.log(`One message of ${len.toLocaleString('en-US')} characters streamed ${step} characters per push into a jsdom node (React production, flushSync per push).\n`)
  console.log('| Variant | Pushes | Total | Per push p50 | p95 | worst | Same DOM as (a) |\n|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const same = r.hashes.filter((h, i) => h === base.hashes[i]).length
    console.log(`| ${labels[r.impl]} | ${r.pushes} | ${fmt(r.totalMs)}${r.impl === 'remark' ? '' : ` (**${(base.totalMs / r.totalMs).toFixed(1)}x** less)`} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} | ${same}/${base.hashes.length} |`)
    if (same !== base.hashes.length) process.exitCode = 1
  }
  process.exit()
}

const root = new URL('../..', import.meta.url).pathname + '/'
const impl = args.impl
const driver = `
import React from 'react'
import {flushSync} from 'react-dom'
import {createRoot} from 'react-dom/client'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParseFast from ${JSON.stringify(root + 'index.js')}
import {createStreamParser} from ${JSON.stringify(root + 'stream.js')}
import {StreamMarkdown} from ${JSON.stringify(root + 'examples/react-chat/StreamMarkdown.jsx')}
import {chatAnswer} from ${JSON.stringify(root + 'bench/perf/chat-text.mjs')}
const fnv = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(16) + ':' + s.length }
window.runStream = (impl, {len, step, verifyEvery}) => {
  const text = chatAnswer(len)
  const el = document.createElement('div'); document.body.append(el)
  const root = createRoot(el)
  const sp = impl === 'stream' ? createStreamParser() : null
  const plugins = impl === 'samemark' ? [remarkParseFast, remarkGfm] : [remarkGfm]
  const times = [], hashes = []
  let pos = 0, n = 0
  while (pos < text.length) {
    const from = pos
    pos = Math.min(text.length, pos + step)
    const t0 = performance.now()
    flushSync(() => root.render(sp ? React.createElement(StreamMarkdown, {tree: sp.push(text.slice(from, pos))}) : React.createElement(Markdown, {remarkPlugins: plugins}, text.slice(0, pos))))
    times.push(performance.now() - t0)
    if (++n % verifyEvery === 0) hashes.push(fnv(el.innerHTML))
  }
  hashes.push(fnv(el.innerHTML))
  return {times, hashes}
}`
const res = await build({stdin: {contents: driver, resolveDir: root}, bundle: true, format: 'iife', platform: 'browser', minify: true, write: false, logLevel: 'error', jsx: 'automatic', loader: {'.jsx': 'jsx'}, alias: {'samemark/stream': root + 'stream.js'}, define: {'process.env.NODE_ENV': '"production"'}})
const dom = new JSDOM('<!doctype html><body></body>', {runScripts: 'outside-only', pretendToBeVisual: true})
dom.window.eval(Buffer.from(res.outputFiles[0].contents).toString())
const out = dom.window.runStream(impl, {len, step, verifyEvery: 5})
const t = [...out.times].sort((a, b) => a - b)
const sum = out.times.reduce((a, b) => a + b, 0)
console.log(JSON.stringify({impl, pushes: t.length, totalMs: sum, p50: t[t.length >> 1], p95: t[Math.floor(t.length * 0.95)], max: t.at(-1), hashes: out.hashes}))
