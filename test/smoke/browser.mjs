// Real-browser check (CI): bundles remark-parse + remark-gfm + this package for the browser, runs both parsers
// in Chromium, compares the trees. Needs `npm i --no-save playwright && npx playwright install chromium`.
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {firstDiff} from '../../bench/common.mjs'

const root = new URL('../../', import.meta.url).pathname
const docs = [
  '# Title\n\nSome *emphasis*, `code`, [link](http://a.b "t") &copy; &amp; &#x41;\n\n| a | b |\n|---|---|\n| 1 | ~~2~~ |\n\nwww.example.com[^1]\n\n[^1]: note\n',
  '[a]: /u&amp;x&copy; "&ouml;&#x41;&notit;&nbsp"\n\n[A] [b][a]\r\n\r\n```js &amp;\r\ncode\r\n```\r\n',
  '﻿a\0b\n\n\ud800 *😀* &AMP &amp\n'
]
const contents = `
import {unified} from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import fast, {stats} from 'samemark/core'
const docs = ${JSON.stringify(docs)}
const mk = p => unified().use(p).use(remarkGfm)
window.__result = JSON.stringify(docs.map(d => ({fast: JSON.stringify(mk(fast).parse(d)), ref: JSON.stringify(mk(remarkParse).parse(d))})).concat([{stats}]))
`
const res = await build({stdin: {contents, resolveDir: root}, bundle: true, format: 'iife', platform: 'browser', minify: true, write: false, alias: {'samemark/core': root + 'core.js'}, logLevel: 'error', absWorkingDir: root})
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))
await page.setContent('<!doctype html><title>t</title>')
await page.addScriptTag({content: Buffer.from(res.outputFiles[0].contents).toString()})
const result = JSON.parse(await page.evaluate('window.__result'))
await browser.close()
if (errors.length) throw new Error('page errors: ' + errors.join('\n'))
let bad = 0
result.slice(0, -1).forEach((r, i) => {
  const d = firstDiff(JSON.parse(r.ref), JSON.parse(r.fast))
  if (d) { bad++; console.log(`document ${i} differs: ${JSON.stringify(d).slice(0, 600)}\n  source: ${JSON.stringify(docs[i]).slice(0, 300)}`) }
})
const stats = result.at(-1).stats
console.log(`browser: ${result.length - 1} documents, ${bad} differences, fast=${stats.fast} fallback=${stats.fallback}`)
if (bad || stats.fast !== docs.length) process.exit(1)
