// Fetches the pinned third-party corpora into .corpus/ (gitignored) and verifies them against bench/corpora.json.
//   node bench/fetch-corpora.mjs [--update] [--small] [--only=name,...]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'

const here = new URL('.', import.meta.url).pathname
const manifestFile = here + 'corpora.json'
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
const args = process.argv.slice(2)
const update = args.includes('--update')
const small = args.includes('--small')
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean)
export const corpusRoot = process.env.SAMEMARK_CORPUS_DIR || path.resolve(here, '..', '.corpus')

function walk(dir, re, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '.git') walk(p, re, base, out) } else if (re.test(e.name)) out.push(path.relative(base, p))
  }
  return out.sort()
}
function digest(dir, re) {
  const files = walk(dir, re)
  const h = crypto.createHash('sha256')
  let bytes = 0
  for (const f of files) { const b = fs.readFileSync(path.join(dir, f)); bytes += b.length; h.update(f + '\0'); h.update(b); h.update('\0') }
  return {files: files.length, bytes, sha256: h.digest('hex')}
}

const checkouts = new Map() // repo@sha -> directory, shared by the sources of one commit
for (const src of manifest.sources) {
  if (only.length && !only.includes(src.name)) continue
  if (small && !src.small) continue
  const re = new RegExp(src.include)
  const dest = path.join(corpusRoot, src.role, src.name)
  if (fs.existsSync(dest) && !update) {
    const d = digest(dest, re)
    if (d.sha256 === src.sha256) { console.log(`${src.name}: present, verified (${d.files} files, ${(d.bytes / 1e6).toFixed(2)} MB)`); continue }
    fs.rmSync(dest, {recursive: true})
  }
  const key = src.repo + '@' + src.sha
  let co = checkouts.get(key)
  if (!co) {
    co = fs.mkdtempSync(path.join(fs.realpathSync(process.env.RUNNER_TEMP || os.tmpdir()), 'corpus-'))
    const git = (...a) => execFileSync('git', a, {cwd: co, stdio: ['ignore', 'ignore', 'inherit']})
    git('init', '-q')
    git('remote', 'add', 'origin', `https://github.com/${src.repo}.git`)
    git('sparse-checkout', 'init', '--no-cone')
    const all = manifest.sources.filter(s => s.repo === src.repo && s.sha === src.sha).flatMap(s => s.paths)
    git('sparse-checkout', 'set', '--no-cone', ...all.map(p => '/' + p))
    git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', src.sha)
    git('checkout', '-q', 'FETCH_HEAD')
    checkouts.set(key, co)
  }
  fs.mkdirSync(dest, {recursive: true})
  for (const p of src.paths) {
    const from = path.join(co, p)
    if (fs.statSync(from).isDirectory()) for (const f of walk(from, re)) { fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true}); fs.copyFileSync(path.join(from, f), path.join(dest, f)) }
    else fs.copyFileSync(from, path.join(dest, path.basename(p)))
  }
  const d = digest(dest, re)
  if (update) { Object.assign(src, d); console.log(`${src.name}: ${d.files} files, ${(d.bytes / 1e6).toFixed(2)} MB, ${d.sha256.slice(0, 12)}`) }
  else if (d.sha256 !== src.sha256) { console.error(`${src.name}: digest mismatch (got ${d.sha256}, manifest ${src.sha256})`); process.exit(1) }
  else console.log(`${src.name}: fetched, verified (${d.files} files, ${(d.bytes / 1e6).toFixed(2)} MB)`)
}
for (const co of checkouts.values()) fs.rmSync(co, {recursive: true, force: true})
if (update) fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
