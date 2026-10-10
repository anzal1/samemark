// Builds the live demo into site/dist (static files, no external requests):  node site/build.mjs
import fs from 'node:fs'
import path from 'node:path'
import {build} from 'esbuild'

const root = path.resolve(new URL('..', import.meta.url).pathname) + '/'
const out = root + 'site/dist/'
fs.rmSync(out, {recursive: true, force: true})
fs.mkdirSync(out, {recursive: true})
const result = await build({
  entryPoints: [root + 'site/src/app.jsx'],
  outfile: out + 'app.js',
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: root,
  loader: {'.md': 'text'},
  alias: {'samemark/stream': root + 'stream.js'},
  define: {'process.env.NODE_ENV': '"production"'},
  metafile: true
})
for (const f of ['index.html', 'style.css']) fs.copyFileSync(root + 'site/' + f, out + f)
fs.writeFileSync(out + '.nojekyll', '')
const kb = f => (fs.statSync(out + f).size / 1024).toFixed(0) + ' KB'
console.log(`site/dist: app.js ${kb('app.js')}, index.html ${kb('index.html')}, style.css ${kb('style.css')}`)
