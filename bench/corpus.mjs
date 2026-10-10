// Corpus loader shared by the harnesses. Three sources, all reproducible without the author's machine:
//   docs       third-party markdown fetched at pinned commits by bench/fetch-corpora.mjs into .corpus/docs (not committed)
//   synthetic  generated from a seed (bench/synthetic.mjs), always available
//   readme     optional, slow: the README corpus rebuilt from npm by bench/readme-corpus.mjs into .corpus/readme
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {syntheticDocs} from './synthetic.mjs'

const here = new URL('.', import.meta.url).pathname
export const corpusRoot = process.env.SAMEMARK_CORPUS_DIR || path.resolve(here, '..', '.corpus')
const hashMod = (name, n) => crypto.createHash('md5').update(name).digest().readUInt32BE(0) % n

function listFiles(dir, re) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (re.test(e.name)) out.push(p) } }
  walk(dir)
  return out.sort()
}

/**
 * Documents for identity checks: [{id, src}], sorted, optionally 1 in `sample` by a hash of the id.
 * `docs` and `readme` come from .corpus (missing directories are skipped, or an error with `requireDocs`).
 */
export function loadDocs({sample = 0, docs = true, synthetic = true, readme = false, requireDocs = false, syntheticCount = 240} = {}) {
  const items = []
  if (docs) {
    const files = listFiles(path.join(corpusRoot, 'docs'), /\.md$/i)
    if (files.length === 0 && requireDocs) throw new Error('no docs corpus found: run `node bench/fetch-corpora.mjs` first')
    for (const f of files) items.push({id: 'docs/' + path.relative(path.join(corpusRoot, 'docs'), f), src: fs.readFileSync(f, 'utf8')})
  }
  if (synthetic) items.push(...syntheticDocs(syntheticCount))
  if (readme) {
    const files = listFiles(path.join(corpusRoot, 'readme'), /\.md$/i)
    if (files.length === 0) throw new Error('no README corpus found: run `node bench/readme-corpus.mjs` (slow, optional)')
    for (const f of files) items.push({id: 'readme/' + path.basename(f), src: fs.readFileSync(f, 'utf8')})
  }
  return items.filter(it => !sample || hashMod(it.id, sample) === 0)
}

const EXAMPLE = /^`{32} example[^\n]*\n([\s\S]*?)^\.\n([\s\S]*?)^`{32}$/gm
/** spec examples: CommonMark (from the commonmark-spec npm package) and, when fetched, the GFM spec and extension examples */
export function loadSpecs() {
  const sets = []
  const take = (name, text) => {
    const out = []
    let m, n = 0
    EXAMPLE.lastIndex = 0
    while ((m = EXAMPLE.exec(text))) out.push({id: `${name}${++n}`, src: m[1].replace(/→/g, '\t')})
    sets.push({name, items: out})
  }
  take('commonmark', fs.readFileSync(new URL('../node_modules/commonmark-spec/spec.txt', import.meta.url), 'utf8'))
  for (const f of ['spec.txt', 'extensions.txt']) {
    const p = path.join(corpusRoot, 'spec', 'gfm-spec', f)
    if (fs.existsSync(p)) take('gfm-' + f.replace('.txt', ''), fs.readFileSync(p, 'utf8'))
  }
  return sets
}
