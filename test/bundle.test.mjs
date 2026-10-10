// Minified bundles keep taking the fast path (no reliance on function source or names), and the core
// entry runs in an edge-like VM with no Node built-ins.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {build} from 'esbuild'
import {EdgeVM} from '@edge-runtime/vm'
import {parse} from '../core.js'
import {sample} from './compat-cases.mjs'

const root = new URL('../', import.meta.url).pathname
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samemark-bundle-'))
const plain = t => JSON.parse(JSON.stringify(t))

const doc = sample + '\n| t | u |\n|---|---|\n| `a` | b |\n\n- [ ] task\n\nfoot[^2]\n\n[^2]: x\n'
const driver = `
import {unified} from 'unified'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import remarkFast, {stats} from '${root}index.js'
import {parse as coreParse, stats as coreStats} from '${root}core.js'
const src = ${JSON.stringify(doc)}
const out = {}
const run = (name, ...plugins) => { const p = unified().use(remarkFast); for (const pl of plugins) p.use(...[].concat(pl)); const before = {...stats}; const tree = p.parse(src); out[name] = {fast: stats.fast - before.fast, fallback: stats.fallback - before.fallback, tree} }
run('gfm', remarkGfm)
run('singleTildeFalse', [remarkGfm, {singleTilde: false}])
run('none')
run('frontmatterMath', remarkGfm, remarkFrontmatter, remarkMath)
run('frontmatterYamlToml', remarkGfm, [remarkFrontmatter, ['yaml', 'toml']])
run('customFence', remarkGfm, [remarkFrontmatter, [{type: 'yaml', fence: {open: '---x', close: '---'}}]])
run('noSingleDollar', remarkGfm, [remarkMath, {singleDollarTextMath: false}])
out.core = {tree: coreParse(src), stats: {...coreStats}}
out.reference = unified().use(remarkParse).use(remarkGfm).parse(src)
const refOf = (...plugins) => { const p = unified().use(remarkParse); for (const pl of plugins) p.use(...[].concat(pl)); return p.parse(src) }
out.refFm = refOf(remarkGfm, remarkFrontmatter, remarkMath)
out.refFmToml = refOf(remarkGfm, [remarkFrontmatter, ['yaml', 'toml']])
out.refCustom = refOf(remarkGfm, [remarkFrontmatter, [{type: 'yaml', fence: {open: '---x', close: '---'}}]])
out.refNoSingle = refOf(remarkGfm, [remarkMath, {singleDollarTextMath: false}])
out.referenceSingle = unified().use(remarkParse).use(remarkGfm, {singleTilde: false}).parse(src)
globalThis.__out = JSON.stringify(out)
`

async function bundle(name, opts) {
  const outfile = path.join(tmp, name + '.js')
  await build({stdin: {contents: driver, resolveDir: root}, outfile, bundle: true, format: 'iife', logLevel: 'error', absWorkingDir: root, ...opts})
  return outfile
}

for (const [name, opts] of [
  ['unminified', {minify: false}],
  ['minified (identifiers mangled, whitespace removed)', {minify: true}],
  ['minified, es2015 target', {minify: true, target: 'es2015'}]
]) {
  test(`bundle ${name}: GFM takes the fast path, everything else falls back, trees match remark-parse`, async () => {
    const file = await bundle(name.split(' ')[0] + String(Math.random()).slice(2, 6), {platform: 'node', ...opts})
    const out = JSON.parse(execFileSync(process.execPath, ['-e', `require(${JSON.stringify(file)}); console.log(globalThis.__out)`], {maxBuffer: 1 << 26}).toString())
    assert.deepEqual([out.gfm.fast, out.gfm.fallback], [1, 0], 'GFM must take the fast path in a minified bundle')
    assert.deepEqual([out.singleTildeFalse.fast, out.singleTildeFalse.fallback], [0, 1])
    assert.deepEqual([out.none.fast, out.none.fallback], [0, 1])
    assert.deepEqual([out.frontmatterMath.fast, out.frontmatterMath.fallback], [1, 0], 'frontmatter + math detection must survive minification')
    assert.deepEqual([out.frontmatterYamlToml.fast, out.frontmatterYamlToml.fallback], [1, 0])
    assert.deepEqual([out.noSingleDollar.fast, out.noSingleDollar.fallback], [1, 0])
    assert.deepEqual([out.customFence.fast, out.customFence.fallback], [0, 1], 'a custom fence must still fall back in a minified bundle')
    assert.deepEqual(out.frontmatterMath.tree, out.refFm)
    assert.deepEqual(out.frontmatterYamlToml.tree, out.refFmToml)
    assert.deepEqual(out.customFence.tree, out.refCustom)
    assert.deepEqual(out.noSingleDollar.tree, out.refNoSingle)
    assert.deepEqual(out.gfm.tree, out.reference)
    assert.deepEqual(out.singleTildeFalse.tree, out.referenceSingle)
    assert.deepEqual(out.core.tree, out.reference)
  })
}

test('edge-runtime VM: core entry parses without Node built-ins', async () => {
  const contents = `import {parse, stats} from '${root}core.js'; globalThis.parseDoc = s => JSON.stringify(parse(s)); globalThis.statsJson = () => JSON.stringify(stats)`
  const res = await build({stdin: {contents, resolveDir: root}, bundle: true, format: 'iife', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], minify: true, write: false, metafile: true, logLevel: 'error', absWorkingDir: root})
  const imports = Object.values(res.metafile.outputs).flatMap(o => o.imports.map(i => i.path))
  assert.deepEqual(imports.filter(p => p.startsWith('node:') || !p.startsWith('.')), [], 'no external or node: imports')
  const code = Buffer.from(res.outputFiles[0].contents).toString()
  assert.ok(!/\brequire\(|\bprocess\.|from\s*["']node:/.test(code))
  const vm = new EdgeVM()
  assert.equal(typeof vm.evaluate('typeof process'), 'string')
  assert.equal(vm.evaluate('typeof process'), 'undefined', 'the edge VM has no process')
  assert.equal(vm.evaluate('typeof Buffer'), 'undefined', 'the edge VM has no Buffer')
  vm.evaluate(code)
  const got = JSON.parse(vm.evaluate(`parseDoc(${JSON.stringify(doc)})`))
  assert.deepEqual(got, plain(parse(doc)))
  assert.equal(JSON.parse(vm.evaluate('statsJson()')).fast, 1)
})

test.after(() => fs.rmSync(tmp, {recursive: true, force: true}))
