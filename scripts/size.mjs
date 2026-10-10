// Bundle sizes (esbuild, minified, ESM, platform neutral). Prints a markdown table.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {build} from 'esbuild'

const root = new URL('../', import.meta.url).pathname
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samemark-size-'))
const w = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f }

async function size(label, entry, opts = {}) {
  const out = await build({entryPoints: [entry], bundle: true, minify: true, format: 'esm', platform: 'neutral', target: 'es2020', write: false, legalComments: 'none', logLevel: 'error', absWorkingDir: root, ...opts})
  const code = Buffer.from(out.outputFiles[0].contents)
  return {label, min: code.length, gzip: zlib.gzipSync(code, {level: 9}).length, brotli: zlib.brotliCompressSync(code).length}
}

const rows = []
rows.push(await size('samemark/core (parser + 6 helper packages, everything the fast path needs)', root + 'core.js'))
rows.push(await size('samemark/core for browsers (bundler uses the `browser` condition: entities decoded by the DOM)', root + 'core.js', {platform: 'browser'}))
rows.push(await size('samemark/stream (incremental parser for streamed text)', root + 'stream.js'))
rows.push(await size('samemark main entry, mdast-util-from-markdown left external (peer)', root + 'index.js', {external: ['mdast-util-from-markdown']}))
rows.push(await size('samemark main entry, everything bundled (includes mdast-util-from-markdown + micromark)', root + 'index.js'))
rows.push(await size('  of which: decode-named-character-reference (HTML entity table)', w('e.js', `import {decodeNamedCharacterReference as d} from '${root}node_modules/decode-named-character-reference/index.js'; globalThis.x = d`)))
rows.push(await size('baseline: mdast-util-from-markdown + micromark-extension-gfm + mdast-util-gfm', w('b.js', `import {fromMarkdown} from '${root}node_modules/mdast-util-from-markdown/index.js'; import {gfm} from '${root}node_modules/micromark-extension-gfm/index.js'; import {gfmFromMarkdown} from '${root}node_modules/mdast-util-gfm/index.js'; globalThis.x = () => fromMarkdown('', {extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()]})`)))
rows.push(await size('baseline: unified + remark-parse + remark-gfm', w('c.js', `import {unified} from '${root}node_modules/unified/index.js'; import remarkParse from '${root}node_modules/remark-parse/index.js'; import remarkGfm from '${root}node_modules/remark-gfm/index.js'; globalThis.x = unified().use(remarkParse).use(remarkGfm)`)))
fs.rmSync(tmp, {recursive: true, force: true})

const kb = n => (n / 1024).toFixed(1) + ' KB'
console.log('| bundle | minified | gzip | brotli |\n|---|---|---|---|')
for (const r of rows) console.log(`| ${r.label} | ${kb(r.min)} | ${kb(r.gzip)} | ${kb(r.brotli)} |`)
if (process.argv.includes('--json')) fs.writeFileSync(process.argv[process.argv.indexOf('--json') + 1], JSON.stringify(rows, null, 2))
