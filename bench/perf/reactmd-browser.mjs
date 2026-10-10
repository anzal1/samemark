// react-markdown in Chromium, with the CPU throttled to 4x and 6x as a rough phone proxy (CDP
// Emulation.setCPUThrottlingRate, which slows the main thread uniformly). CI only:
//   npm i --no-save --no-package-lock playwright@1.64.0 && npx playwright install --with-deps chromium
//   node bench/perf/reactmd-browser.mjs [--markdown=file] [--json=file]
import fs from 'node:fs'
import path from 'node:path'
import {build} from 'esbuild'
import {chromium} from 'playwright'

const root = path.resolve(new URL('../..', import.meta.url).pathname) + '/'
const arg = n => (process.argv.find(a => a.startsWith('--' + n + '=')) || '').slice(n.length + 3)
const rates = [1, 4, 6]
const driver = `
import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParseFast, {stats} from ${JSON.stringify(root + 'index.js')}
import {measure} from ${JSON.stringify(root + 'bench/perf/reactmd-core.mjs')}
window.runBench = (impl, cfg) => {
  const remarkPlugins = impl === 'samemark' ? [remarkParseFast, remarkGfm] : [remarkGfm]
  const render = text => renderToStaticMarkup(React.createElement(Markdown, {remarkPlugins}, text))
  const out = measure({render, ...cfg})
  out.stats = {...stats}
  return out
}
`
const res = await build({stdin: {contents: driver, resolveDir: root}, bundle: true, format: 'iife', platform: 'browser', minify: true, write: false, logLevel: 'error', absWorkingDir: root, define: {'process.env.NODE_ENV': '"production"'}})
const code = Buffer.from(res.outputFiles[0].contents).toString()
const cfg = {lengths: [10000, 30000], reps: 7, streams: [{len: 10000, step: 100, runs: 1}, {len: 30000, step: 100, runs: 1}], verifyStep: 500}

const streamDriver = `
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
// one chat message streamed into a real DOM node: every push is committed synchronously (flushSync), so the time per
// push is parse + React render + DOM commit; layout and paint are not included for any variant
window.runStream = (impl, {len, step, verifyEvery}) => {
  const text = chatAnswer(len)
  const el = document.createElement('div')
  document.body.append(el)
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
  root.unmount(); el.remove()
  return {times, hashes}
}
`
const streamRes = await build({stdin: {contents: streamDriver, resolveDir: root}, bundle: true, format: 'iife', platform: 'browser', minify: true, write: false, logLevel: 'error', absWorkingDir: root, jsx: 'automatic', loader: {'.jsx': 'jsx'}, alias: {'samemark/stream': root + 'stream.js'}, define: {'process.env.NODE_ENV': '"production"'}})
const streamCode = Buffer.from(streamRes.outputFiles[0].contents).toString()
const streamCfg = {len: 30000, step: 40, verifyEvery: 25}

const browser = await chromium.launch()
const version = browser.version()
const results = {}
for (const rate of rates) {
  results[rate] = {}
  for (const impl of ['remark', 'samemark']) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(String(e)))
    await page.setContent('<!doctype html><title>b</title>')
    await page.addScriptTag({content: code})
    const client = await page.context().newCDPSession(page)
    await client.send('Emulation.setCPUThrottlingRate', {rate})
    results[rate][impl] = await page.evaluate(([i, c]) => window.runBench(i, c), [impl, cfg])
    if (errors.length) throw new Error(errors.join('\n'))
    await page.close()
    console.error(`rate ${rate}x ${impl} done`)
  }
}
const streamResults = {}
for (const rate of rates) {
  streamResults[rate] = {}
  for (const impl of ['remark', 'samemark', 'stream']) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(String(e)))
    await page.setContent('<!doctype html><title>s</title>')
    await page.addScriptTag({content: streamCode})
    const client = await page.context().newCDPSession(page)
    await client.send('Emulation.setCPUThrottlingRate', {rate})
    streamResults[rate][impl] = await page.evaluate(([i, c]) => window.runStream(i, c), [impl, streamCfg])
    if (errors.length) throw new Error(errors.join('\n'))
    await page.close()
    console.error(`stream rate ${rate}x ${impl} done`)
  }
}
await browser.close()

const fmt = ms => ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(ms < 10 ? 1 : 0) + ' ms'
const lines = ['### react-markdown in Chromium, CPU throttled as a phone proxy', '',
  `Chromium ${version}, react-markdown 10.1.0 production bundle, \`renderToStaticMarkup\` in the page. CPU throttling uses DevTools \`Emulation.setCPUThrottlingRate\` (4x and 6x slowdown of the main thread). It is a proxy for a slower device, not a measurement of one. Same chat-style input as the desktop table; streaming steps are 100 characters here to keep the throttled runs short.`, '',
  '| CPU | Update at 10,000 characters: default / samemark | Update at 30,000 characters: default / samemark | Stream to 10,000: mean update default / samemark | Stream to 30,000: mean update default / samemark | Identical HTML |',
  '|---|---|---|---|---|---|']
let bad = 0
for (const rate of rates) {
  const a = results[rate].remark, b = results[rate].samemark
  const ident = a.prefixHashes.filter((h, i) => h === b.prefixHashes[i]).length
  if (ident !== a.prefixHashes.length) bad++
  const f = L => `${fmt(a.fixed[L].medianMs)} / ${fmt(b.fixed[L].medianMs)} (**${(a.fixed[L].medianMs / b.fixed[L].medianMs).toFixed(1)}x**)`
  const s = L => `${fmt(a.stream[L].meanMs)} / ${fmt(b.stream[L].meanMs)} (**${(a.stream[L].meanMs / b.stream[L].meanMs).toFixed(1)}x**)`
  lines.push(`| ${rate === 1 ? 'no throttling' : rate + 'x slower'} | ${f(10000)} | ${f(30000)} | ${s(10000)} | ${s(30000)} | ${ident}/${a.prefixHashes.length} |`)
  if (b.stats.fallback) { console.error('samemark fell back in the browser'); bad++ }
}
lines.push('')
const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))] }
const sum = a => a.reduce((x, y) => x + y, 0)
lines.push('### Streaming a 30,000 character answer into the DOM', '',
  `One chat message streamed ${streamCfg.step} characters per push into a real DOM node (Chromium ${version}, React ${'19'} production, \`flushSync\` per push, so each push is parse + React render + DOM commit; layout and paint are not included). (a) react-markdown re-rendering the whole message per push, (b) the same with samemark as the parser, (c) the stream parser with per-block memoisation (\`examples/react-chat\`). "Total" is the sum of all push times on the main thread. The DOM after the final push, and after every ${streamCfg.verifyEvery}th push, is compared with (a): the last column.`, '',
  '| CPU | Variant | Pushes | Total | Per push p50 | p95 | worst | Same DOM as (a) |', '|---|---|---|---|---|---|---|---|')
for (const rate of rates) {
  const base = streamResults[rate].remark
  for (const [impl, label] of [['remark', '(a) react-markdown, whole message per push'], ['samemark', '(b) react-markdown + samemark'], ['stream', '(c) stream parser + memoised blocks']]) {
    const r = streamResults[rate][impl]
    const same = r.hashes.filter((h, i) => h === base.hashes[i]).length
    if (same !== base.hashes.length) bad++
    const speed = impl === 'remark' ? '' : ` (**${(sum(base.times) / sum(r.times)).toFixed(1)}x** less)`
    lines.push(`| ${rate === 1 ? 'no throttling' : rate + 'x slower'} | ${label} | ${r.times.length} | ${fmt(sum(r.times))}${speed} | ${fmt(pct(r.times, 0.5))} | ${fmt(pct(r.times, 0.95))} | ${fmt(Math.max(...r.times))} | ${same}/${base.hashes.length} |`)
  }
}
lines.push('')
console.log(lines.join('\n'))
if (arg('markdown')) { fs.mkdirSync(path.dirname(arg('markdown')), {recursive: true}); fs.writeFileSync(arg('markdown'), lines.join('\n') + '\n') }
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({results, streamResults}))
if (bad) process.exit(1)
