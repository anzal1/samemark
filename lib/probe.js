// A tiny driver that runs a real micromark construct tokenizer over a probe string, so behaviour that hides in
// closures (frontmatter fences, `singleDollarTextMath`, `singleTilde`) can be read without function names or source.
// It implements only what those tokenizers use: enter / exit / consume / attempt / check, self.now(), self.previous.

function where(text, pos) {
  let line = 1, ls = 0
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) { line++; ls = i + 1 }
  return {line, column: pos - ls + 1, offset: pos}
}

/** run `construct.tokenize` at `start`; returns {ok, end, types} (types = token types entered, in order) */
export function drive(construct, text, start = 0, depth = 0) {
  if (depth > 8) return {ok: false, end: start, types: []}
  let pos = start
  const types = []
  let result = null
  const self = {previous: start === 0 ? null : text.charCodeAt(start - 1), events: [], now: () => where(text, pos), parser: {constructs: {}}}
  // micromark codes: -5 CR, -4 LF, -3 CRLF (one code, two chars), -2 horizontal tab, null at the end
  const at = () => {
    if (pos >= text.length) return null
    const c = text.charCodeAt(pos)
    if (c === 10) return -4
    if (c === 13) return text.charCodeAt(pos + 1) === 10 ? -3 : -5
    if (c === 9) return -2
    return c
  }
  const effects = {
    enter(type) { types.push(type); return {type} },
    exit(type) { return {type} },
    consume(code) { pos += code === -3 ? 2 : 1 },
    attempt(c, okState, nokState) {
      return () => {
        const r = drive(c, text, pos, depth + 1)
        if (r.ok) { pos = r.end; return okState(at()) }
        return nokState(at())
      }
    },
    check(c, okState, nokState) {
      return () => (drive(c, text, pos, depth + 1).ok ? okState(at()) : nokState(at()))
    }
  }
  const ok = () => { result = true; return null }
  const nok = () => { result = false; return null }
  let state = construct.tokenize.call(self, effects, ok, nok)
  for (let steps = 0; typeof state === 'function' && steps < 100000; steps++) state = state(at())
  return {ok: result === true, end: pos, types}
}

function constructsAt(exts, hook, code, flat) {
  const out = []
  for (const ext of flat(exts)) {
    const v = ext[hook] && ext[hook][code]
    for (const c of Array.isArray(v) ? v : v ? [v] : []) if (c && typeof c.tokenize === 'function') out.push(c)
  }
  return out
}

const FM_PROBES = [
  '---\na: 1\n---\n', '---\n---\n', '---  \t\nx\n---\t \n', '---\nx\n--- \n', '---\nx\n----\n', '---\nx\n--\n---\n', '----\nx\n----\n',
  '--\nx\n--\n', '---x\nx\n---\n', '---\nx', '---\r\nx\r\n---\r\n', '---\n\n\n---', '---\nx\n---x\n---\n', '---\nx\n-- -\n---\n',
  '---\n---', ' ---\nx\n---\n@1', 'a\n---\nx\n---\n@2'
]

/**
 * Behaviour fingerprint of the frontmatter constructs among `exts`: for probe inputs starting with `-` or `+` (and probes
 * that start at column 2 or on line 2) the token type and end offset of the first construct that accepts, or `nok`.
 */
export function frontmatterProfile(exts, flat) {
  const out = []
  for (const ch of ['-', '+']) {
    for (const probe of FM_PROBES) {
      const at = probe.endsWith('@1') ? 1 : probe.endsWith('@2') ? 2 : 0
      const body = at ? probe.slice(0, -2) : probe
      const text = ch === '-' ? body : body.replace(/-/g, '+')
      const start = at === 1 ? 1 : at === 2 ? text.indexOf('\n') + 1 : 0
      const cs = constructsAt(exts, 'flow', text.charCodeAt(start), flat)
      let r = 'none'
      for (const c of cs) {
        const d = drive(c, text, start)
        if (d.ok) { r = d.types[0] + ':' + (d.end - start); break }
        r = 'nok'
      }
      out.push(r)
    }
  }
  return out.join(',')
}

/** does the text construct at `$` accept a lone `$a$` (single dollar math) and `$$a$$`? */
export function mathTextProfile(exts, flat) {
  const cs = constructsAt(exts, 'text', 36, flat).filter(c => c.name === 'mathText')
  return ['$a$', '$$a$$', '$$$a$$$'].map(t => {
    let r = 'none'
    for (const c of cs) { const d = drive(c, t, 0); r = d.ok ? 'ok:' + d.end : 'nok'; break }
    return r
  }).join(',')
}

/** does the strikethrough tokenizer accept a lone `~`? (`singleTilde`) */
export function singleTilde(exts, flat) {
  let seen = 0
  for (const c of constructsAt(exts, 'text', 126, flat)) {
    if (c.name !== 'strikethrough') continue
    seen++
    const d = drive(c, '~a ', 0)
    if (!d.ok) return false
  }
  return seen > 0
}
