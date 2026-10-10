// Installs the packed tarball into an empty project (only its declared dependencies, no devDependencies) and
// exercises both entries from ESM and CommonMark-era CJS. Proves `files`, `exports` and `dependencies` are complete.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'

const root = new URL('../', import.meta.url).pathname
const run = (cmd, args, cwd, input) => {
  const r = spawnSync(cmd, args, {cwd, encoding: 'utf8', input})
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed in ${cwd}\n${r.stdout}\n${r.stderr}`); process.exit(1) }
  return r.stdout
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samemark-consumer-'))
const packed = run('npm', ['pack', '--pack-destination', tmp, '--silent'], root).trim().split('\n').pop()
console.log('packed', packed)
const listing = JSON.parse(run('npm', ['pack', '--dry-run', '--json'], root))[0].files.map(f => f.path)
console.log(listing.join('\n'))
for (const bad of listing.filter(f => /^(corpus|bench|test|node_modules|\.github)\//.test(f))) { console.error('unexpected file in package: ' + bad); process.exit(1) }

fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({name: 'consumer', private: true, type: 'module'}))
run('npm', ['install', '--no-audit', '--no-fund', path.join(tmp, packed), 'mdast-util-from-markdown@2.1.0', 'unified@11.0.5', 'remark-parse@11.0.0', 'remark-gfm@4.0.1'], tmp)

fs.writeFileSync(path.join(tmp, 'esm.mjs'), `
import assert from 'node:assert/strict'
import {unified} from 'unified'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import fast, {parse, stats} from 'samemark'
import coreFast, {parse as coreParse} from 'samemark/core'
import {createStreamParser} from 'samemark/stream'
const src = '# a *b*\\n\\n- [x] ~~c~~ www.d.com\\n'
const ref = unified().use(remarkParse).use(remarkGfm).parse(src)
const mine = unified().use(fast).use(remarkGfm).parse(src)
assert.deepEqual(JSON.parse(JSON.stringify(mine)), JSON.parse(JSON.stringify(ref)))
assert.deepEqual(JSON.parse(JSON.stringify(parse(src))), JSON.parse(JSON.stringify(ref)))
assert.deepEqual(JSON.parse(JSON.stringify(coreParse(src))), JSON.parse(JSON.stringify(ref)))
assert.deepEqual(JSON.parse(JSON.stringify(unified().use(coreFast).use(remarkGfm).parse(src))), JSON.parse(JSON.stringify(ref)))
assert.ok(stats.fast >= 2 && stats.fallback === 0)
const sp = createStreamParser()
let streamed
for (let i = 0; i < src.length; i += 7) streamed = sp.push(src.slice(i, i + 7))
assert.deepEqual(JSON.parse(JSON.stringify(streamed)), JSON.parse(JSON.stringify(ref)))
console.log('esm ok')
`)
run('node', ['esm.mjs'], tmp)
fs.writeFileSync(path.join(tmp, 'cjs.cjs'), `
const assert = require('node:assert/strict')
const core = require('samemark/core')
const tree = core.parse('# a *b*\\n\\n- [x] ~~c~~\\n')
assert.equal(tree.children[0].type, 'heading')
assert.equal(typeof core.default, 'function')
assert.equal(typeof core, 'function')
const {createStreamParser: cs} = require('samemark/stream')
assert.equal(cs().push('# a').children[0].type, 'heading')
console.log('cjs ok')
`)
console.log(run('node', ['cjs.cjs'], tmp))
// the fast path must not need anything outside its declared dependencies: core without mdast-util-from-markdown installed
run('npm', ['uninstall', '--no-audit', '--no-fund', 'mdast-util-from-markdown', 'remark-parse'], tmp)
fs.writeFileSync(path.join(tmp, 'corealone.mjs'), `import {parse} from 'samemark/core'; if (parse('*a*').children[0].children[0].type !== 'emphasis') throw new Error('bad'); console.log('core without peers ok')`)
console.log(run('node', ['corealone.mjs'], tmp))
fs.rmSync(tmp, {recursive: true, force: true})
