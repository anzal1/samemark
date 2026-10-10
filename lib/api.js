// Shared implementation of both entries. `createApi(defaultFallback, verify)`:
//   defaultFallback: (text, ctx) => Root, or null (core entry: no fallback import)
//   verify: optional (micromarkExtensions, fromMarkdownExtensions) => boolean, a one-time behavioural self-check
import {parse as parseFast, normalizeMatters} from '../src/block.js'
import {micromarkSignature, mdastSignature, frontmatterConfigs, mathConfig} from './signature.js'
import {flat, micromarkRows, mdastRows} from './rows.js'
import {singleTilde, frontmatterProfile, mathTextProfile} from './probe.js'

const NAME = 'samemark'
const EMPTY = []
const OURS = Symbol.for('samemark.parser')
const NO_FEATURES = {reason: null, features: null}

function firstMissing(have, want) {
  const set = new Set(have)
  for (const r of want) if (!set.has(r)) return r
  return null
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Decide whether the fast parser reproduces `micro` + `fromExts` exactly.
 * Returns {reason: string|null, features}: features are the options for the parser (`frontmatter`, `math`).
 * Supported: stock GFM, optionally with frontmatter (yaml, toml, both) and math (single dollar or not).
 * Behaviour hidden in closures (frontmatter fences, `singleDollarTextMath`, `singleTilde`) is read by running the
 * real tokenizers on probe strings (lib/probe.js), never by looking at names or source, so minified code works.
 */
function inspect(micro, fromExts) {
  const mr = micromarkRows(micro)
  const dr = mdastRows(fromExts)
  if (mr.length === 0 && dr.length === 0) return {reason: 'no GFM extensions (CommonMark-only parsing needs the fallback)'}
  const miss = firstMissing(mr, micromarkSignature)
  const missM = firstMissing(dr, mdastSignature)
  if (miss !== null) return {reason: `GFM is not fully enabled (missing micromark construct ${miss})`}
  if (missM !== null) return {reason: `GFM is not fully enabled (missing from-markdown handler ${missM})`}
  if (!singleTilde(micro, flat)) return {reason: 'strikethrough is not the stock GFM one (singleTilde: false or unknown tokenizer)'}
  const gm = new Set(micromarkSignature), gd = new Set(mdastSignature)
  let mRest = mr.filter(r => !gm.has(r)), dRest = dr.filter(r => !gd.has(r))
  const features = {}

  // math
  const mathM = mathConfig.micromark, mathD = mathConfig.mdast
  if (mRest.some(r => mathM.includes(r)) || dRest.some(r => mathD.includes(r))) {
    const lack = firstMissing(mRest, mathM) !== null ? false : firstMissing(dRest, mathD) === null
    if (!lack) return {reason: 'math is only partly enabled'}
    const profile = mathTextProfile(micro, flat)
    if (profile === mathConfig.profiles.single) features.math = {single: true}
    else if (profile === mathConfig.profiles.noSingle) features.math = {single: false}
    else return {reason: 'math text construct behaves differently from micromark-extension-math'}
    mRest = mRest.filter(r => !mathM.includes(r)); dRest = dRest.filter(r => !mathD.includes(r))
  }

  // frontmatter
  if (mRest.length || dRest.length) {
    for (const [name, cfg] of Object.entries(frontmatterConfigs)) {
      if (same(mRest, cfg.micromark) && same(dRest, cfg.mdast)) {
        if (frontmatterProfile(micro, flat) !== cfg.profile) return {reason: `frontmatter fences differ from the stock ${name} matters (custom or \`anywhere\` matter)`}
        features.frontmatter = normalizeMatters(cfg.options)
        mRest = []; dRest = []
        break
      }
    }
  }
  if (mRest.length) return {reason: `micromark extension not in the supported set (GFM, frontmatter, math): ${mRest[0]}`}
  if (dRest.length) return {reason: `from-markdown extension not in the supported set (GFM, frontmatter, math): ${dRest[0]}`}
  return {reason: null, features}
}

function toText(doc) {
  if (typeof doc === 'string') return doc
  if (doc instanceof Uint8Array) return new TextDecoder('utf-8', {ignoreBOM: true}).decode(doc)
  return String(doc)
}

export function createApi(defaultFallback, verify) {
  const stats = {fast: 0, fallback: 0, lastFallbackReason: null}
  const decisions = new WeakMap() // micromark ext array -> WeakMap(from-markdown ext array -> reason | null)
  const warned = new Set()

  // Decisions are cached twice: by array identity (a processor reuses its arrays) and by content. The second level
  // matters for react-markdown, which builds a fresh unified processor, with fresh extension arrays, on every render.
  const byKey = new Map()

  /** {reason, features}: reason is null when the fast path is exact for these extensions */
  function decide(micro, fromExts) {
    micro = micro || EMPTY
    fromExts = fromExts || EMPTY
    let byMicro = decisions.get(micro)
    if (byMicro === undefined) { byMicro = new WeakMap(); decisions.set(micro, byMicro) }
    let d = byMicro.get(fromExts)
    if (d !== undefined) return d
    let key = null
    try {
      // names of every construct and handler, plus the behaviour probes that names cannot show
      key = micromarkRows(micro).join('\n') + '\u0000' + mdastRows(fromExts).join('\n') + '\u0000' + singleTilde(micro, flat) + '\u0000' + frontmatterProfile(micro, flat) + '\u0000' + mathTextProfile(micro, flat)
    } catch (e) { key = null }
    d = key === null ? undefined : byKey.get(key)
    if (d === undefined) {
      try { d = inspect(micro, fromExts) } catch (e) { d = {reason: 'extension inspection failed: ' + (e && e.message)} }
      if (d.reason === null && verify) {
        try { if (!verify(micro, fromExts, d.features)) d = {reason: 'self-check against mdast-util-from-markdown failed (version drift?)'} } catch (e) { d = {reason: 'self-check threw: ' + (e && e.message)} }
      }
      if (key !== null) byKey.set(key, d)
    }
    byMicro.set(fromExts, d)
    return d
  }
  const check = (micro, fromExts) => decide(micro, fromExts).reason

  function run(text, micro, fromExts, opts, ctx, previous) {
    const d = micro === undefined ? NO_FEATURES : decide(micro, fromExts)
    let reason = d.reason
    const strict = opts.strict === true
    const fb = opts.fallback || defaultFallback || previous || null
    if (reason === null) {
      try {
        const tree = d.features && (d.features.frontmatter || d.features.math) ? parseFast(text, d.features) : parseFast(text)
        stats.fast++
        return tree
      } catch (e) {
        if (strict || !fb) throw e
        reason = 'fast parser threw: ' + (e && e.message)
      }
    }
    if (strict) throw new Error(`${NAME}: the fast path cannot be used (${reason})`)
    if (!fb) throw new Error(`${NAME}/core: the fast path cannot be used (${reason}) and no fallback is configured. Use the main entry, pass {fallback}, or put remark-parse before this plugin.`)
    stats.fallback++
    stats.lastFallbackReason = reason
    if (typeof opts.onFallback === 'function') opts.onFallback(reason)
    if (opts.warn && !warned.has(reason)) { warned.add(reason); console.warn(`${NAME}: using the slow fallback parser: ${reason}`) }
    return fb(text, ctx)
  }

  function parse(source, options) {
    const o = options || {}
    return run(toText(source), o.extensions === undefined && o.mdastExtensions === undefined ? undefined : o.extensions || EMPTY,
      o.mdastExtensions, o, {extensions: flat(o.extensions), mdastExtensions: flat(o.mdastExtensions), settings: undefined}, null)
  }

  function remarkParseFast(options) {
    const self = this
    const o = options || {}
    const prev = self.parser && !self.parser[OURS] ? self.parser : null
    function parser(doc, file) {
      const micro = self.data('micromarkExtensions') || EMPTY
      const fromExts = self.data('fromMarkdownExtensions') || EMPTY
      const ctx = {extensions: micro, mdastExtensions: fromExts, settings: self.data('settings')}
      return run(toText(doc), micro, fromExts, o, ctx, prev && ((text) => prev.call(self, text, file)))
    }
    parser[OURS] = true
    self.parser = parser
  }

  return {parse, remarkParseFast, stats, check}
}
