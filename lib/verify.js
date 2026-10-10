// One-time behavioural self-check used by the main entry, which has mdast-util-from-markdown at hand.
// Runs a few documents through both parsers with the processor's own extensions; any difference sends
// that processor to the fallback. Guards against micromark patch releases that change behaviour.
import {parse as parseFast} from '../src/block.js'
import {flat} from './rows.js'

const PROBES = [
  '~a~ ~~b~~ ~~~c~~~ www.a.com/b_(c). <x@y.z> https://a.b/c?d=e&f. foo@bar.baz **a *b** c*',
  '- [ ] a\n- [x] *b*\n\n| a | `b\\|c` |\n|:-|-:|\n| x | y |\n\nt[^1] ![^1]\n\n[^1]: n\n\n[r]: /u "t"\n[r] [s][r] ![i][r] [r][]',
  '---\ntitle: x\n---\n\n# h $a$ $$b$$\n\n$$\nc\n$$\n\ntext\n',
  '+++\nt = 1\n+++\n- a\n',
  '# h\n\nsetext\n===\n\n> q\n> - a\n>   - b\n\n```js a\ncode\n```\n\n<div>\nx\n</div>\n\n&amp; \\* `c` a  \nb [l](<u> "t") <https://a.b>\n\n\ttab\n\n1. x\n2. y\n'
]

export function deepEq(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  let na = 0
  for (const k in a) { if (a[k] === undefined) continue; na++; if (!deepEq(a[k], b[k])) return false }
  let nb = 0
  for (const k in b) if (b[k] !== undefined) nb++
  return na === nb
}

export function makeVerify(fromMarkdown) {
  return function verify(micro, fromExts, features) {
    const opts = {extensions: flat(micro), mdastExtensions: flat(fromExts)}
    const popts = features && (features.frontmatter || features.math) ? features : undefined
    for (const p of PROBES) if (!deepEq(fromMarkdown(p, opts), parseFast(p, popts))) return false
    return true
  }
}
