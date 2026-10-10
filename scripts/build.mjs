// Builds dist/: a CommonJS bundles of the core and stream entries (helpers inlined, zero requires) plus the licences of what it inlines.
// The ESM entries are shipped as source, no build step.
import fs from 'node:fs'
import {build} from 'esbuild'

const root = new URL('../', import.meta.url).pathname
fs.mkdirSync(root + 'dist', {recursive: true})
await build({
  entryPoints: [root + 'core.js', root + 'stream.js'],
  outdir: root + 'dist', entryNames: '[name]',  outExtension: {'.js': '.cjs'},
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2020',
  legalComments: 'none',
  logLevel: 'warning'
})
// esbuild exposes `default` as an own property; make `require('samemark/core')` also usable as the plugin itself
fs.appendFileSync(root + 'dist/core.cjs', '\nmodule.exports = Object.assign(module.exports.default, module.exports, {default: module.exports.default});\n')

const bundled = ['ccount', 'decode-named-character-reference', 'micromark-util-decode-numeric-character-reference', 'micromark-util-decode-string', 'micromark-util-html-tag-name', 'micromark-util-normalize-identifier', 'micromark-util-character', 'micromark-util-symbol', 'character-entities']
let text = 'dist/core.cjs and dist/stream.cjs inline these MIT-licensed packages. Their licences:\n'
for (const name of bundled) {
  const dir = root + 'node_modules/' + name + '/'
  if (!fs.existsSync(dir)) continue
  const pkg = JSON.parse(fs.readFileSync(dir + 'package.json', 'utf8'))
  const lic = fs.readdirSync(dir).find(f => /^licen[sc]e/i.test(f))
  text += `\n---- ${name}@${pkg.version} ----\n${lic ? fs.readFileSync(dir + lic, 'utf8').trim() : 'MIT (no licence file shipped)'}\n`
}
fs.writeFileSync(root + 'dist/LICENSES.txt', text)
console.error('built dist/core.cjs', fs.statSync(root + 'dist/core.cjs').size, 'bytes, dist/stream.cjs', fs.statSync(root + 'dist/stream.cjs').size, 'bytes')
