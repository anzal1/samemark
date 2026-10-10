// OPTIONAL and SLOW: rebuilds the README corpus used during development (the "README corpus" rows of the README) from npm.
// For every entry of bench/readme-corpus-manifest.json it runs `npm pack name@version`, takes the package's README, checks
// its sha256 against the manifest and writes it to .corpus/readme/<first 12 hex of sha256>.md. Thousands of tarballs: use
// --limit while trying it out. Entries whose README no longer matches (republished or yanked) are reported and skipped.
//   node bench/readme-corpus.mjs [--limit=200] [--concurrency=6]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const run = promisify(execFile)
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a.slice(2), true] }))
const manifest = JSON.parse(fs.readFileSync(new URL('./readme-corpus-manifest.json', import.meta.url), 'utf8'))
const entries = manifest.entries.slice(0, Number(args.limit || Infinity))
const out = path.resolve(new URL('..', import.meta.url).pathname, process.env.SAMEMARK_CORPUS_DIR || '.corpus', 'readme')
fs.mkdirSync(out, {recursive: true})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samemark-readme-'))
let next = 0, ok = 0, bad = 0, missing = 0

async function one(e, n) {
  const dir = path.join(tmp, String(n))
  fs.mkdirSync(dir)
  try {
    const {stdout} = await run('npm', ['pack', `${e.name}@${e.version}`, '--pack-destination', dir, '--silent', '--ignore-scripts'], {maxBuffer: 1 << 24})
    const tgz = path.join(dir, stdout.trim().split('\n').pop())
    const {stdout: list} = await run('tar', ['-tzf', tgz], {maxBuffer: 1 << 26})
    const name = list.split('\n').find(f => /^package\/readme(\.md|\.markdown)?$/i.test(f))
    if (!name) { missing++; return }
    const {stdout: body} = await run('tar', ['-xzOf', tgz, name], {maxBuffer: 1 << 26, encoding: 'buffer'})
    const sha = crypto.createHash('sha256').update(body).digest('hex')
    if (sha === e.sha256) { fs.writeFileSync(path.join(out, sha.slice(0, 12) + '.md'), body); ok++ } else bad++
  } catch { missing++ } finally { fs.rmSync(dir, {recursive: true, force: true}) }
}
async function worker() { while (next < entries.length) { const n = next++; await one(entries[n], n); if (n % 100 === 99) console.error(`${n + 1}/${entries.length} ok ${ok} changed ${bad} missing ${missing}`) } }
await Promise.all(Array.from({length: Number(args.concurrency || 6)}, worker))
fs.rmSync(tmp, {recursive: true, force: true})
console.log(`README corpus: ${ok} of ${entries.length} rebuilt in ${out} (${bad} changed since, ${missing} unavailable)`)
