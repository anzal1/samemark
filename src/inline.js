// Hand-written inline (phrasing) parser producing mdast identical to
// micromark (text content type) + gfm extensions + mdast-util-from-markdown/gfm.
// See NOTES.md for the micromark quirks matched here.
//
// Pipeline per phrasing container: scan -> flat token list (typed by kind) -> resolve
// attention/strikethrough pairs (match records) -> one build pass producing mdast nodes.
import {decodeNamedCharacterReference} from 'decode-named-character-reference'
import {decodeNumericCharacterReference} from 'micromark-util-decode-numeric-character-reference'
import {normalizeIdentifier} from 'micromark-util-normalize-identifier'
import {decodeString} from 'micromark-util-decode-string'
import {ccount} from 'ccount'

// ---------------------------------------------------------------- tables
// character classes for attention/autolink-literal: 0 other, 1 whitespace, 2 punctuation
const CLS = new Uint8Array(65536)
{
  const ws = /\s/, pu = /\p{P}|\p{S}/u
  for (let c = 0; c < 65536; c++) {
    if (c === 9 || c === 10 || c === 13 || c === 32) { CLS[c] = 1; continue }
    const s = String.fromCharCode(c)
    if (ws.test(s)) CLS[c] = 1
    else if (pu.test(s)) CLS[c] = 2
  }
}
function cls(c) { return c < 0 ? 1 : CLS[c] }

const PUNCT = new Uint8Array(128)
for (let c = 33; c <= 47; c++) PUNCT[c] = 1
for (let c = 58; c <= 64; c++) PUNCT[c] = 1
for (let c = 91; c <= 96; c++) PUNCT[c] = 1
for (let c = 123; c <= 126; c++) PUNCT[c] = 1

// asciiAtext = [#-'*+\--9=?A-Z^-~]
const ATEXT = new Uint8Array(128)
for (let c = 35; c <= 39; c++) ATEXT[c] = 1
ATEXT[42] = ATEXT[43] = 1
for (let c = 45; c <= 57; c++) ATEXT[c] = 1
ATEXT[61] = ATEXT[63] = 1
for (let c = 65; c <= 90; c++) ATEXT[c] = 1
for (let c = 94; c <= 126; c++) ATEXT[c] = 1

// gfm atext: [+-._A-Za-z0-9]
const GATEXT = new Uint8Array(128)
GATEXT[43] = GATEXT[45] = GATEXT[46] = GATEXT[95] = 1
for (let c = 48; c <= 57; c++) GATEXT[c] = 1
for (let c = 65; c <= 90; c++) GATEXT[c] = 1
for (let c = 97; c <= 122; c++) GATEXT[c] = 1

function isAlpha(c) { c |= 32; return c >= 97 && c <= 122 }
function isDigit(c) { return c >= 48 && c <= 57 }
function isAlnum(c) { const d = c | 32; return (d >= 97 && d <= 122) || (c >= 48 && c <= 57) }
function isHex(c) { const d = c | 32; return (d >= 97 && d <= 102) || (c >= 48 && c <= 57) }
function isAsciiPunct(c) { return c >= 33 && c < 128 && PUNCT[c] === 1 }
function gatext(c) { return c >= 0 && c < 128 && GATEXT[c] === 1 }

// scan classes
const S_DOLLAR = 14
const S_EOL = 1, S_BSL = 2, S_AMP = 3, S_ATT = 4, S_TILDE = 5, S_TICK = 6, S_LT = 7, S_LB = 8, S_BANG = 9, S_RB = 10, S_H = 11, S_W = 12, S_AT = 13
const LUT = new Uint8Array(128)
LUT[10] = LUT[13] = S_EOL
LUT[92] = S_BSL; LUT[38] = S_AMP; LUT[42] = LUT[95] = S_ATT; LUT[126] = S_TILDE; LUT[96] = S_TICK
LUT[60] = S_LT; LUT[91] = S_LB; LUT[33] = S_BANG; LUT[93] = S_RB
LUT[104] = LUT[72] = S_H; LUT[119] = LUT[87] = S_W
const LUT_AT = LUT.slice()
for (let c = 0; c < 128; c++) if (GATEXT[c] === 1 && LUT_AT[c] === 0) LUT_AT[c] = S_AT
const LUT_M = LUT.slice(), LUT_AT_M = LUT_AT.slice()
LUT_M[36] = LUT_AT_M[36] = S_DOLLAR

// token kinds
const K_MATH = 18
const K_ESC = 1, K_REF = 2, K_EOL = 3, K_BRKESC = 4, K_CODE = 5, K_HTML = 6, K_AUTO = 7, K_LIT = 8, K_ATT = 9, K_STK = 10,
  K_LSTART = 11, K_ISTART = 12, K_LINK_OPEN = 13, K_IMG_OPEN = 14, K_GROUP_CLOSE = 15, K_FOOT = 16, K_TEXT = 17
// token flags (tX)
const OPEN = 1, CLOSE = 2, INACTIVE = 4, BALANCED = 8

// ---------------------------------------------------------------- state
let SRC = ''
let T = '', n = 0, start0 = 0
let single = true, Lline = 0, Lls = 0
let ckT = [], ckSrc = [], ckLine = [], ckLs = [], ckV = [], nck = 0
let defs = null, fdefs = null
let inTable = false
let taskLen = 0, taskCand = false

// token arrays: typed and grown by doubling; reused across calls
let cap = 1024
let tKind = new Uint8Array(cap)
let tS = new Int32Array(cap), tE = new Int32Array(cap), tX = new Int32Array(cap)
let aRs = new Int32Array(cap), aRe = new Int32Array(cap), aOH = new Int32Array(cap), aCH = new Int32Array(cap), aCT = new Int32Array(cap)
let attL = new Int32Array(cap), stkL = new Int32Array(cap)
let lsStack = new Int32Array(cap)
const tO = []
let nt = 0
let mcap = 1024
let mUse = new Uint8Array(mcap), mNO = new Int32Array(mcap), mNC = new Int32Array(mcap)
let nm = 0
let na = 0, nsk = 0
let lsTop = 0
let firstSeq = 0, lastInt = -1, escEnd = -1
let hasAt = false
let replayUntil = -1

export function setDefinitions(d, f) { defs = d; fdefs = f }
// streaming: record which definition / footnote ids a run looked up, and whether they were defined, so a later
// change in the definition sets can be detected (`^id` = footnote)
let trackDefs = false
const runNeg = [], runPos = []
export function setTrackDefs(b) { trackDefs = b }
export function takeNeeds() {
  if (runNeg.length === 0 && runPos.length === 0) return null
  const r = {neg: runNeg.slice(), pos: runPos.slice()}
  runNeg.length = 0; runPos.length = 0
  return r
}
function hasDef(id) {
  const h = defs !== null && defs.has(id)
  if (trackDefs) (h ? runPos : runNeg).push(id)
  return h
}
function hasFn(id) {
  const h = fdefs !== null && fdefs.has(id)
  if (trackDefs) (h ? runPos : runNeg).push('^' + id)
  return h
}
let mathOn = false, mathSingle = true
export function setMath(on, single) { mathOn = on; mathSingle = single }
export function setSource(s) { SRC = s }

function grow() {
  const nc = cap * 2
  const g8 = a => { const b = new Uint8Array(nc); b.set(a); return b }
  const g32 = a => { const b = new Int32Array(nc); b.set(a); return b }
  tKind = g8(tKind); tS = g32(tS); tE = g32(tE); tX = g32(tX)
  aRs = g32(aRs); aRe = g32(aRe); aOH = g32(aOH); aCH = g32(aCH); aCT = g32(aCT)
  attL = g32(attL); stkL = g32(stkL); lsStack = g32(lsStack)
  cap = nc
}
function newMatch(use) {
  if (nm >= mcap) {
    const nc = mcap * 2
    const a = new Uint8Array(nc); a.set(mUse); mUse = a
    const b = new Int32Array(nc); b.set(mNO); mNO = b
    const c = new Int32Array(nc); c.set(mNC); mNC = c
    mcap = nc
  }
  mUse[nm] = use
  return nm++
}
function addTok(k, s, e, x) {
  if (nt >= cap) grow()
  const t = nt++
  tKind[t] = k; tS[t] = s; tE[t] = e; tX[t] = x
  return t
}
function addSeq(k, s, e, flags) {
  const t = addTok(k, s, e, flags)
  aRs[t] = s; aRe[t] = e; aOH[t] = -1; aCH[t] = -1; aCT[t] = -1
  return t
}

function at(j) { return j < n ? T.charCodeAt(j) : -1 }

// ---------------------------------------------------------------- points
function findChunk(i) {
  let lo = 0, hi = nck - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ckT[mid] <= i) lo = mid; else hi = mid - 1
  }
  return lo
}
function ptS(i) {
  if (single) return {line: Lline, column: i - Lls + 1, offset: i}
  const k = findChunk(i)
  const d = i - ckT[k] - ckV[k]
  const off = ckSrc[k] + (d > 0 ? d : 0)
  return {line: ckLine[k], column: off - ckLs[k] + 1, offset: off}
}
function ptE(i) { return ptS(i) }
// End point of a line ending token (i = index after the line ending). The text tokenizer only knows the
// container prefix of the next chunk once that chunk is written; a line ending that is consumed again
// after a failed multi-line attempt (code span, html, resource...) therefore ends after the prefix,
// while a line ending consumed on the first pass ends at column 1 of the next line.
function ptEol(i, replayed) {
  if (single) return {line: Lline, column: i - Lls + 1, offset: i}
  const k = findChunk(i)
  if (k > 0 && i === ckT[k]) {
    if (replayed) return ptS(i)
    return {line: ckLine[k], column: 1, offset: ckLs[k]}
  }
  return ptS(i)
}

// ---------------------------------------------------------------- scan
function scan() {
  nt = 0; na = 0; nsk = 0; lsTop = 0; nm = 0; firstSeq = 0; lastInt = -1; escEnd = -1
  btBuiltA[0] = false; btBuiltA[1] = false; trailInit = false; replayUntil = -1; htmlFail = -1; failAt = -1
  htmlDead[0] = htmlDead[1] = htmlDead[2] = htmlDead[3] = htmlDead[4] = htmlDead[5] = 0x7fffffff
  hasAt = false
  for (let q = start0; q < n; q++) if (T.charCodeAt(q) === 64) { hasAt = true; break }
  const lut = mathOn ? (hasAt ? LUT_AT_M : LUT_M) : (hasAt ? LUT_AT : LUT)
  let i = start0 + taskLen
  if (taskCand && T.charCodeAt(start0) === 91) {
    // tasklistCheck consumes `[` and a line ending as the value, then fails on the next chunk: replay
    const c1 = at(start0 + 1)
    if (c1 === 10) replayUntil = start0 + 2
    else if (c1 === 13) replayUntil = start0 + (at(start0 + 2) === 10 ? 3 : 2)
  }
  while (i < n) {
    const c = T.charCodeAt(i)
    const k = c < 128 ? lut[c] : 0
    if (k === 0) { i++; continue }
    switch (k) {
      case S_EOL: {
        let e = i + 1
        if (c === 13 && e < n && T.charCodeAt(e) === 10) e++
        let x = e
        while (x < n) { const d = T.charCodeAt(x); if (d === 32 || d === 9) x++; else break }
        { const t = addTok(K_EOL, i, e, x); tO[t] = i < replayUntil }
        i = x
        continue
      }
      case S_BSL: {
        const d = at(i + 1)
        if (d === 10 || d === 13) { addTok(K_BRKESC, i, i + 1, 0); i++; continue }
        if (d >= 33 && d < 128 && PUNCT[d] === 1) { addTok(K_ESC, i, i + 2, 0); i += 2; escEnd = i; continue }
        i++
        continue
      }
      case S_AMP: {
        const j = charRef(i)
        if (j > 0) { i = j; continue }
        i++
        continue
      }
      case S_ATT: {
        if (hasAt && c === 95 && emailStart(i)) { const j = emailAt(i); if (j > 0) { lit(i, j, 2); i = j; continue } }
        let r = i + 1
        while (r < n && T.charCodeAt(r) === c) r++
        const prev = i > start0 ? T.charCodeAt(i - 1) : -1
        const next = r < n ? T.charCodeAt(r) : -1
        const before = cls(prev), after = cls(next)
        const open = after === 0 || (after === 2 && before !== 0) || next === 126
        const close = before === 0 || (before === 2 && after !== 0) || prev === 126
        let o, cl
        if (c === 42) { o = open; cl = close } else { o = open && (before !== 0 || !close); cl = close && (after !== 0 || !open) }
        if (firstSeq === 0) firstSeq = 1
        const t = addSeq(K_ATT, i, r, (o ? OPEN : 0) | (cl ? CLOSE : 0))
        attL[na++] = t
        i = r
        continue
      }
      case S_TILDE: {
        const prev = i > start0 ? T.charCodeAt(i - 1) : -1
        if (prev === 126 && escEnd !== i) { i++; continue }
        let r = i + 1
        if (r < n && T.charCodeAt(r) === 126) { r++; if (r < n && T.charCodeAt(r) === 126) { i++; continue } }
        const next = r < n ? T.charCodeAt(r) : -1
        const before = cls(prev), after = cls(next)
        const o = after === 0 || (after === 2 && before !== 0)
        const cl = before === 0 || (before === 2 && after !== 0)
        if (firstSeq === 0) firstSeq = 2
        const t = addSeq(K_STK, i, r, (o ? OPEN : 0) | (cl ? CLOSE : 0))
        stkL[nsk++] = t
        i = r
        continue
      }
      case S_DOLLAR: {
        if (i > start0 && T.charCodeAt(i - 1) === 36 && escEnd !== i) { i++; continue }
        let r = i + 1
        while (r < n && T.charCodeAt(r) === 36) r++
        if (r - i < 2 && !mathSingle) { i = r; continue }
        const close = findRun(1, i, r - i)
        if (close < 0) { replayUntil = n; i = r; continue }
        codeSpan(i, r, close, K_MATH)
        i = close + (r - i)
        continue
      }
      case S_TICK: {
        if (i > start0 && T.charCodeAt(i - 1) === 96 && escEnd !== i) { i++; continue }
        let r = i + 1
        while (r < n && T.charCodeAt(r) === 96) r++
        const close = findRun(0, i, r - i)
        if (close < 0) { replayUntil = n; i = r; continue }
        codeSpan(i, r, close, K_CODE)
        i = close + (r - i)
        continue
      }
      case S_LT: {
        let j = autolinkAt(i)
        if (j > 0) { const t = addTok(K_AUTO, i, j, alKind); tO[t] = alS; i = j; continue }
        j = htmlAt(i)
        if (j > 0) { addTok(K_HTML, i, j, 0); i = j; continue }
        if (htmlFail > replayUntil) replayUntil = htmlFail
        i++
        continue
      }
      case S_LB: {
        if ((trackDefs || (fdefs !== null && fdefs.size > 0)) && at(i + 1) === 94) {
          const j = footCallAt(i)
          if (j > 0) { const t = addTok(K_FOOT, i, j, 0); tO[t] = T.slice(i + 2, j - 1); lastInt = t; i = j; continue }
        }
        const t = addTok(K_LSTART, i, i + 1, 0)
        lsStack[lsTop++] = t
        lastInt = t
        i++
        continue
      }
      case S_BANG: {
        if (at(i + 1) === 91) {
          const t = addTok(K_ISTART, i, i + 2, 0)
          lsStack[lsTop++] = t
          lastInt = t
          i += 2
          continue
        }
        i++
        continue
      }
      case S_RB: {
        const j = labelEnd(i)
        if (j > 0) { i = j; continue }
        i++
        continue
      }
      case S_H: {
        if (hasAt && emailStart(i)) { const j = emailAt(i); if (j > 0) { lit(i, j, 2); i = j; continue } }
        if (lsTop === 0) {
          const j = protocolAt(i)
          if (j > 0) { lit(i, j, 0); i = j; continue }
        }
        i++
        continue
      }
      case S_W: {
        if (hasAt && emailStart(i)) { const j = emailAt(i); if (j > 0) { lit(i, j, 2); i = j; continue } }
        if (lsTop === 0) {
          const j = wwwAt(i)
          if (j > 0) { lit(i, j, 1); i = j; continue }
        }
        i++
        continue
      }
      case S_AT: {
        if (emailStart(i)) { const j = emailAt(i); if (j > 0) { lit(i, j, 2); i = j; continue } }
        i++
        continue
      }
      default:
        i++
    }
  }
}

function lit(s, e, type) { addTok(K_LIT, s, e, type) }

// ---------------------------------------------------------------- character references
function charRef(i) {
  let j = i + 1
  let c = at(j)
  if (c === 35) {
    j++
    c = at(j)
    let hex = false, max = 7
    if (c === 120 || c === 88) { hex = true; max = 6; j++ }
    const s = j
    let size = 0
    for (;;) {
      c = at(j)
      if (c === 59 && size) break
      if ((hex ? isHex(c) : isDigit(c)) && size++ < max) { j++; continue }
      return -1
    }
    const v = decodeNumericCharacterReference(T.slice(s, j), hex ? 16 : 10)
    const t = addTok(K_REF, i, j + 1, 0)
    tO[t] = v
    return j + 1
  }
  const s = j
  let size = 0
  for (;;) {
    c = at(j)
    if (c === 59 && size) break
    if (isAlnum(c) && size++ < 31) { j++; continue }
    return -1
  }
  const v = decodeNamedCharacterReference(T.slice(s, j))
  if (!v) return -1
  const t = addTok(K_REF, i, j + 1, 0)
  tO[t] = v
  return j + 1
}

// ---------------------------------------------------------------- code spans
// runs of backticks (code spans) and dollars (math text), indexed by run length for linear closer lookup
const btBuiltA = [false, false]
const btMaps = [null, null]
function buildRuns(w, ch, chs) {
  btBuiltA[w] = true
  const map = new Map()
  btMaps[w] = map
  let p = T.indexOf(chs, start0)
  while (p !== -1 && p < n) {
    let r = p + 1
    while (r < n && T.charCodeAt(r) === ch) r++
    const L = r - p
    let e = map.get(L)
    if (e === undefined) { e = {list: [], ptr: 0}; map.set(L, e) }
    e.list.push(p)
    p = T.indexOf(chs, r)
  }
}
// start index of the next run of exactly L chars (w: 0 backtick, 1 dollar) starting at or after i+L, else -1
function findRun(w, i, L) {
  if (!btBuiltA[w]) buildRuns(w, w === 0 ? 96 : 36, w === 0 ? '`' : '$')
  const e = btMaps[w].get(L)
  if (e === undefined) return -1
  const list = e.list
  const from = i + L
  let p = e.ptr
  while (p < list.length && list[p] < from) p++
  e.ptr = p
  return p < list.length ? list[p] : -1
}
function virt(i) {
  if (single) return false
  const k = findChunk(i)
  return ckV[k] > 0 && i - ckT[k] < ckV[k]
}
function isPad(c) { return c === 32 || c === 10 || c === 13 }
function codeSpan(i, r, close, kind) {
  const L = r - i
  let vs = r, ve = close
  const f = T.charCodeAt(vs), l = T.charCodeAt(ve - 1)
  // virtual spaces (the rest of a tab split by a container prefix) are data, never padding
  if (ve > vs && isPad(f) && isPad(l) && !virt(vs) && !virt(ve - 1)) {
    let data = false
    for (let p = vs; p < ve; p++) {
      const c = T.charCodeAt(p)
      if ((c !== 32 && c !== 10 && c !== 13) || virt(p)) { data = true; break }
    }
    if (data) {
      vs += (f === 13 && T.charCodeAt(vs + 1) === 10) ? 2 : 1
      ve -= (l === 10 && ve - 2 >= vs && T.charCodeAt(ve - 2) === 13) ? 2 : 1
    }
  }
  const t = addTok(kind, i, close + L, vs)
  tO[t] = ve
}

// ---------------------------------------------------------------- autolinks <...>
let alKind = 0, alS = 0
function autolinkAt(i) {
  let j = i + 1
  let c = at(j)
  let size = 0
  let st // 0 schemeOrEmailAtext, 1 schemeInside, 2 urlInside, 3 emailAtext, 4 emailAtSignOrDot, 5 emailLabel, 6 emailValue
  if (isAlpha(c)) { j++; st = 0 }
  else if (c === 64) return -1
  else st = 3
  for (;;) {
    c = at(j)
    switch (st) {
      case 0:
        if (c === 43 || c === 45 || c === 46 || isAlnum(c)) { size = 1; st = 1 } else st = 3
        continue
      case 1:
        if (c === 58) { j++; size = 0; st = 2; continue }
        if ((c === 43 || c === 45 || c === 46 || isAlnum(c)) && size++ < 32) { j++; continue }
        size = 0
        st = 3
        continue
      case 2:
        if (c === 62) { alKind = 0; alS = i + 1; return j + 1 }
        if (c === -1 || c === 32 || c === 60 || c < 32 || c === 127) return -1
        j++
        continue
      case 3:
        if (c === 64) { j++; st = 4; continue }
        if (c >= 0 && c < 128 && ATEXT[c] === 1) { j++; continue }
        return -1
      case 4:
        if (isAlnum(c)) { st = 5; continue }
        return -1
      case 5:
        if (c === 46) { j++; size = 0; st = 4; continue }
        if (c === 62) { alKind = 1; alS = i + 1; return j + 1 }
        st = 6
        continue
      case 6:
        if ((c === 45 || isAlnum(c)) && size++ < 63) { j++; st = c === 45 ? 6 : 5; continue }
        return -1
    }
  }
}

// ---------------------------------------------------------------- html text
const htmlDead = [0x7fffffff, 0x7fffffff, 0x7fffffff, 0x7fffffff, 0x7fffffff, 0x7fffffff]
let htmlFail = -1
function htmlNok(j) { htmlFail = j; return -1 }
function htmlAt(i) {
  let j = i + 1
  let c = at(j)
  // states
  const S_OPEN = 0, S_DECL_OPEN = 1, S_COMMENT_OPEN_INSIDE = 2, S_COMMENT = 3, S_COMMENT_CLOSE = 4, S_COMMENT_END = 5,
    S_CDATA_OPEN = 6, S_CDATA = 7, S_CDATA_CLOSE = 8, S_CDATA_END = 9, S_DECL = 10, S_INSTR = 11, S_INSTR_CLOSE = 12,
    S_TAG_CLOSE_START = 13, S_TAG_CLOSE = 14, S_TAG_CLOSE_BETWEEN = 15, S_TAG_OPEN = 16, S_TAG_OPEN_BETWEEN = 17,
    S_ATTR_NAME = 18, S_ATTR_NAME_AFTER = 19, S_ATTR_VAL_BEFORE = 20, S_ATTR_VAL_QUOTED = 21, S_ATTR_VAL_UNQUOTED = 22,
    S_ATTR_VAL_QUOTED_AFTER = 23, S_END = 24
  let st = S_OPEN
  let index = 0
  let marker = 0
  let qstart = 0
  // consuming helpers inline; `ret` is the state to return to after a line ending
  for (;;) {
    c = at(j)
    // line ending handling shared by many states
    switch (st) {
      case S_OPEN:
        if (c === 33) { j++; st = S_DECL_OPEN; continue }
        if (c === 47) { j++; st = S_TAG_CLOSE_START; continue }
        if (c === 63) { if (i >= htmlDead[2]) return htmlNok(n); j++; st = S_INSTR; continue }
        if (isAlpha(c)) { j++; st = S_TAG_OPEN; continue }
        return htmlNok(j)
      case S_DECL_OPEN:
        if (c === 45) { if (i >= htmlDead[0]) return htmlNok(n); j++; st = S_COMMENT_OPEN_INSIDE; continue }
        if (c === 91) { if (i >= htmlDead[1]) return htmlNok(n); j++; index = 0; st = S_CDATA_OPEN; continue }
        if (isAlpha(c)) { if (i >= htmlDead[3]) return htmlNok(n); j++; st = S_DECL; continue }
        return htmlNok(j)
      case S_COMMENT_OPEN_INSIDE:
        if (c === 45) { j++; st = S_COMMENT_END; continue }
        return htmlNok(j)
      case S_COMMENT:
        if (c === -1) { htmlDead[0] = i; return htmlNok(j) }
        if (c === 45) { j++; st = S_COMMENT_CLOSE; continue }
        if (c === 10 || c === 13) { j = htmlEol(j); continue }
        j++
        continue
      case S_COMMENT_CLOSE:
        if (c === 45) { j++; st = S_COMMENT_END; continue }
        st = S_COMMENT
        continue
      case S_COMMENT_END:
        if (c === 62) { st = S_END; continue }
        if (c === 45) { st = S_COMMENT_CLOSE; continue }
        st = S_COMMENT
        continue
      case S_CDATA_OPEN: {
        const want = 'CDATA['.charCodeAt(index++)
        if (c === want) { j++; st = index === 6 ? S_CDATA : S_CDATA_OPEN; continue }
        return htmlNok(j)
      }
      case S_CDATA:
        if (c === -1) { htmlDead[1] = i; return htmlNok(j) }
        if (c === 93) { j++; st = S_CDATA_CLOSE; continue }
        if (c === 10 || c === 13) { j = htmlEol(j); continue }
        j++
        continue
      case S_CDATA_CLOSE:
        if (c === 93) { j++; st = S_CDATA_END; continue }
        st = S_CDATA
        continue
      case S_CDATA_END:
        if (c === 62) { st = S_END; continue }
        if (c === 93) { j++; continue }
        st = S_CDATA
        continue
      case S_DECL:
        if (c === -1) { htmlDead[3] = i; return htmlNok(j) }
        if (c === 62) { st = S_END; continue }
        if (c === 10 || c === 13) { j = htmlEol(j); continue }
        j++
        continue
      case S_INSTR:
        if (c === -1) { htmlDead[2] = i; return htmlNok(j) }
        if (c === 63) { j++; st = S_INSTR_CLOSE; continue }
        if (c === 10 || c === 13) { j = htmlEol(j); continue }
        j++
        continue
      case S_INSTR_CLOSE:
        if (c === 62) { st = S_END; continue }
        st = S_INSTR
        continue
      case S_TAG_CLOSE_START:
        if (isAlpha(c)) { j++; st = S_TAG_CLOSE; continue }
        return htmlNok(j)
      case S_TAG_CLOSE:
        if (c === 45 || isAlnum(c)) { j++; continue }
        st = S_TAG_CLOSE_BETWEEN
        continue
      case S_TAG_CLOSE_BETWEEN:
        if (c === 10 || c === 13) { j = htmlEol(j); continue }
        if (c === 32 || c === 9) { j++; continue }
        st = S_END
        continue
      case S_TAG_OPEN:
        if (c === 45 || isAlnum(c)) { j++; continue }
        if (c === 47 || c === 62 || c === 10 || c === 13 || c === 32 || c === 9) { st = S_TAG_OPEN_BETWEEN; continue }
        return htmlNok(j)
      case S_TAG_OPEN_BETWEEN:
        if (c === 47) { j++; st = S_END; continue }
        if (c === 58 || c === 95 || isAlpha(c)) { j++; st = S_ATTR_NAME; continue }
        if (c === 10 || c === 13) { j = htmlEol(j); continue }
        if (c === 32 || c === 9) { j++; continue }
        st = S_END
        continue
      case S_ATTR_NAME:
        if (c === 45 || c === 46 || c === 58 || c === 95 || isAlnum(c)) { j++; continue }
        st = S_ATTR_NAME_AFTER
        continue
      case S_ATTR_NAME_AFTER:
        if (c === 61) { j++; st = S_ATTR_VAL_BEFORE; continue }
        if (c === 10 || c === 13) { j = htmlEol(j); continue }
        if (c === 32 || c === 9) { j++; continue }
        st = S_TAG_OPEN_BETWEEN
        continue
      case S_ATTR_VAL_BEFORE:
        if (c === -1 || c === 60 || c === 61 || c === 62 || c === 96) return htmlNok(j)
        if (c === 34 || c === 39) { if (j >= htmlDead[c === 34 ? 4 : 5]) return htmlNok(j); j++; marker = c; qstart = j; st = S_ATTR_VAL_QUOTED; continue }
        if (c === 10 || c === 13) { j = htmlEol(j); continue }
        if (c === 32 || c === 9) { j++; continue }
        j++
        st = S_ATTR_VAL_UNQUOTED
        continue
      case S_ATTR_VAL_QUOTED:
        if (c === marker) { j++; st = S_ATTR_VAL_QUOTED_AFTER; continue }
        if (c === -1) { htmlDead[marker === 34 ? 4 : 5] = qstart - 1; return htmlNok(j) }
        if (c === 10 || c === 13) { j = htmlEol(j); continue }
        j++
        continue
      case S_ATTR_VAL_UNQUOTED:
        if (c === -1 || c === 34 || c === 39 || c === 60 || c === 61 || c === 96) return htmlNok(j)
        if (c === 47 || c === 62 || c === 10 || c === 13 || c === 32 || c === 9) { st = S_TAG_OPEN_BETWEEN; continue }
        j++
        continue
      case S_ATTR_VAL_QUOTED_AFTER:
        if (c === 47 || c === 62 || c === 10 || c === 13 || c === 32 || c === 9) { st = S_TAG_OPEN_BETWEEN; continue }
        return htmlNok(j)
      case S_END:
        if (c === 62) return j + 1
        return htmlNok(j)
    }
  }
}
// physical (tab-expanded) column of T index j, which must be a chunk start
function physCol(j) {
  if (single) return 0
  const k = findChunk(j)
  const off = ckSrc[k] + Math.max(0, j - ckT[k] - ckV[k])
  let col = 0
  for (let q = ckLs[k]; q < off; q++) col += SRC.charCodeAt(q) === 9 ? 4 - (col & 3) : 1
  return col
}
let htmlLeftover = 0
// After a line ending inside html text up to 3 columns of whitespace are line prefix. A tab straddling the
// limit stays (as the remaining virtual spaces). Returns the index where html text continues;
// htmlLeftover = number of virtual spaces kept from a straddling tab.
function htmlPrefix(j) {
  let consumed = 0
  let col = physCol(j)
  htmlLeftover = 0
  while (consumed < 3) {
    const d = at(j)
    if (d === 32) { j++; consumed++; col++ }
    else if (d === 9) {
      const w = 4 - (col & 3)
      if (consumed + w <= 3) { j++; consumed += w; col += w }
      else { htmlLeftover = w - (3 - consumed); break }
    } else break
  }
  return j
}
// consume a line ending inside html text plus its line prefix
function htmlEol(j) {
  const c = T.charCodeAt(j)
  j += (c === 13 && at(j + 1) === 10) ? 2 : 1
  return htmlPrefix(j)
}
function htmlValue(s, e) {
  if (single) return T.slice(s, e)
  let out = ''
  let a = s
  for (let j = s; j < e;) {
    const c = T.charCodeAt(j)
    if (c === 10 || c === 13) {
      let k = j + ((c === 13 && T.charCodeAt(j + 1) === 10) ? 2 : 1)
      out += T.slice(a, k)
      k = htmlPrefix(k)
      if (k > e) k = e
      if (htmlLeftover > 0 && k < e) { out += ' '.repeat(htmlLeftover); k++ }
      a = k
      j = k
    } else j++
  }
  return out + T.slice(a, e)
}

// ---------------------------------------------------------------- footnote call
function footCallAt(i) {
  let j = i + 2, size = 0
  for (;;) {
    const c = at(j)
    if (size > 999 || c === -1 || c === 91 || c === 32 || c === 9 || c === 10 || c === 13) return -1
    if (c === 93) {
      if (j === i + 2) return -1
      if (!hasFn(normalizeIdentifier(T.slice(i + 2, j)))) return -1
      return j + 1
    }
    size++; j++
    if (c === 92) { const d = at(j); if (d === 91 || d === 92 || d === 93) { j++; size++ } }
  }
}

// ---------------------------------------------------------------- label end
function balanceTop() {
  const o = lsStack[--lsTop]
  tX[o] |= BALANCED
}

let resUrl = '', resTitle = null
function ws(j) {
  for (;;) {
    const c = at(j)
    if (c === 10) j++
    else if (c === 13) j += at(j + 1) === 10 ? 2 : 1
    else if (c === 32 || c === 9) j++
    else return j
  }
}
function dec(s) {
  return (s.indexOf('\\') === -1 && s.indexOf('&') === -1) ? s : decodeString(s)
}
let failAt = -1
function parseResource(j) {
  j++
  j = ws(j)
  let c = at(j)
  resUrl = ''; resTitle = null
  if (c === 41) return j + 1
  let urlRaw
  if (c === 60) {
    j++
    const s = j
    for (;;) {
      c = at(j)
      if (c === 62) break
      if (c === -1 || c === 60 || c === 10 || c === 13) return (failAt = j, -1)
      j++
      if (c === 92) { const d = at(j); if (d === 60 || d === 62 || d === 92) j++ }
    }
    urlRaw = T.slice(s, j)
    j++
  } else {
    if (c === -1 || c === 32 || c === 41 || c < 32 || c === 127) return (failAt = j, -1)
    const s = j
    let balance = 0
    for (;;) {
      c = at(j)
      if (balance === 0 && (c === -1 || c === 41 || c === 10 || c === 13 || c === 32 || c === 9)) break
      if (balance < 32 && c === 40) { j++; balance++; continue }
      if (c === 41) { j++; balance--; continue }
      if (c === -1 || c === 32 || c === 40 || c < 32 || c === 127) return (failAt = j, -1)
      j++
      if (c === 92) { const d = at(j); if (d === 40 || d === 41 || d === 92) j++ }
    }
    urlRaw = T.slice(s, j)
  }
  resUrl = dec(urlRaw)
  c = at(j)
  if (c === 10 || c === 13 || c === 32 || c === 9) {
    j = ws(j)
    c = at(j)
    if (c === 34 || c === 39 || c === 40) {
      const marker = c === 40 ? 41 : c
      j++
      if (at(j) === marker) j++
      else {
        let parts = ''
        let seg = j
        for (;;) {
          c = at(j)
          if (c === marker) break
          if (c === -1) return (failAt = j, -1)
          if (c === 10 || c === 13) {
            parts += dec(T.slice(seg, j))
            const el = (c === 13 && at(j + 1) === 10) ? 2 : 1
            parts += T.slice(j, j + el)
            j += el
            for (;;) { const d = at(j); if (d === 32 || d === 9) j++; else break }
            seg = j
            continue
          }
          j++
          if (c === 92) { const d = at(j); if (d === marker || d === 92) j++ }
        }
        parts += dec(T.slice(seg, j))
        resTitle = parts
        j++
      }
      c = at(j)
      if (c === 10 || c === 13 || c === 32 || c === 9) j = ws(j)
    }
  }
  if (at(j) === 41) return j + 1
  return (failAt = j, -1)
}

let lblS = 0, lblE = 0
function parseLabel(j) {
  let size = 0, seen = false
  let p = j + 1
  for (;;) {
    let c = at(p)
    if (size > 999 || c === -1 || c === 91 || (c === 93 && !seen)) return (failAt = p, -1)
    if (c === 93) { lblS = j + 1; lblE = p; return p + 1 }
    if (c === 10 || c === 13) { p += (c === 13 && at(p + 1) === 10) ? 2 : 1; continue }
    for (;;) {
      c = at(p)
      if (c === -1 || c === 91 || c === 93 || c === 10 || c === 13 || size++ > 999) break
      p++
      if (!seen) seen = !(c === 32 || c === 9)
      if (c === 92) { const d = at(p); if (d === 91 || d === 92 || d === 93) { p++; size++ } }
    }
  }
}

let dv = 0
// is the label between the current start and `]` a defined reference? (looked up lazily: only the fallback paths need it;
// definition labels are at most ~1000 raw chars, so longer spans are skipped, which keeps nested brackets linear)
function labelDefined(o, i) {
  if (dv === 0) {
    dv = 1
    if (i - tE[o] <= 1002 && (trackDefs || (defs !== null && defs.size > 0)) && hasDef(normalizeIdentifier(T.slice(tE[o], i)))) dv = 2
  }
  return dv === 2
}
function labelEnd(i) {
  if (lsTop > 0) {
    const o = lsStack[lsTop - 1]
    if ((tX[o] & INACTIVE) !== 0) {
      balanceTop()
    } else {
      dv = 0
      const j = i + 1
      const c = at(j)
      let end = -1, rtype = 0, ls = tE[o], le = i
      if (c === 40) {
        const r = parseResource(j)
        if (r > 0) { end = r; rtype = 0 } else { if (failAt > replayUntil) replayUntil = failAt; if (labelDefined(o, i)) { end = j; rtype = 1 } }
      } else if (c === 91) {
        const r = parseLabel(j)
        const refDef = r > 0 && (trackDefs || (defs !== null && defs.size > 0)) && hasDef(normalizeIdentifier(T.slice(lblS, lblE)))
        if (r < 0 && failAt > replayUntil) replayUntil = failAt
        else if (r > 0 && !refDef && r > replayUntil) replayUntil = r // syntactically fine, undefined: the attempt still failed
        if (refDef) { end = r; rtype = 3; ls = lblS; le = lblE }
        else if (labelDefined(o, i) && at(j + 1) === 93) { end = j + 2; rtype = 2 }
      } else if (labelDefined(o, i)) { end = j; rtype = 1 }
      if (end > 0) {
        formGroup(o, i, end, rtype, ls, le)
        return end
      }
      balanceTop()
    }
  }
  // potential footnote call: ![^id]
  if ((trackDefs || (fdefs !== null && fdefs.size > 0)) && lastInt >= 0 && tKind[lastInt] === K_ISTART && (tX[lastInt] & BALANCED) !== 0) {
    const o = lastInt
    const id = i - tE[o] <= 1002 ? normalizeIdentifier(T.slice(tE[o], i)) : ''
    if (id.charCodeAt(0) === 94 && hasFn(id.slice(1))) {
      const s = tS[o]
      // drop everything from the image start on
      nt = o
      while (na > 0 && attL[na - 1] >= o) na--
      while (nsk > 0 && stkL[nsk - 1] >= o) nsk--
      addTok(K_TEXT, s, s + 1, 0)
      const t = addTok(K_FOOT, s + 1, i + 1, 0)
      tO[t] = T.slice(s + 3, i)
      lastInt = t
      return i + 1
    }
  }
  return -1
}

function formGroup(o, i, end, rtype, ls, le) {
  const isLink = tKind[o] === K_LSTART
  // resolve attention and strikethrough inside the label
  let ai = na
  while (ai > 0 && attL[ai - 1] > o) ai--
  let si = nsk
  while (si > 0 && stkL[si - 1] > o) si--
  if (ai < na || si < nsk) {
    resolveSeqs(attL, ai, na, stkL, si, nsk, false)
    na = ai; nsk = si
  }
  lsTop--
  if (isLink) {
    // links cannot contain links: deactivate earlier link starts
    for (let k = lsTop - 1; k >= 0; k--) {
      const q = lsStack[k]
      if (tKind[q] !== K_LSTART) continue
      if ((tX[q] & INACTIVE) !== 0) break
      tX[q] |= INACTIVE
    }
  }
  tKind[o] = isLink ? K_LINK_OPEN : K_IMG_OPEN
  const t = addTok(K_GROUP_CLOSE, i, end, o)
  tO[t] = {rtype, url: resUrl, title: resTitle, ls, le}
  lastInt = t
}

// ---------------------------------------------------------------- attention / strikethrough resolution
// Port of micromark resolveAllAttention / resolveAllStrikethrough. Every match re-resolves the slice
// between opener and closer (insideSpan: strikethrough, then attention) with the CURRENT run lengths:
// a run that was partly consumed as an opener can become a valid closer inside the span.
function addMatch(use, o, t) {
  const m = newMatch(use)
  mNO[m] = aOH[o]; aOH[o] = m
  mNC[m] = -1
  if (aCT[t] === -1) aCH[t] = m; else mNC[aCT[t]] = m
  aCT[t] = m
  return m
}

function resolveSeqs(aA, a0, a1, sA, s0, s1, attFirst) {
  if (a0 >= a1 && s0 >= s1) return
  if (s0 >= s1) { attPair(aA, a0, a1, null, 0, 0); return }
  if (a0 >= a1) { stkPair(sA, s0, s1, null, 0, 0); return }
  if (attFirst) attPair(aA, a0, a1, sA, s0, s1)
  else stkPair(sA, s0, s1, aA, a0, a1)
}

// attention pairing over arr[lo, hi); sArr[s0, s1) are strikethrough tokens to interleave (resolved
// inside enclosing pairs, and as a second phase afterwards)
function attPair(arr, lo, hi, sArr, s0, s1) {
  const starSt = [], undSt = []
  let starLen = 0, undLen = 0
  const bot = new Int32Array(12)
  const pendA = [], pendS = []
  let si = s0
  for (let k = lo; k < hi; k++) {
    const t = arr[k]
    if (sArr !== null) while (si < s1 && sArr[si] < t) pendS.push(sArr[si++])
    const x = tX[t]
    const isStar = T.charCodeAt(tS[t]) === 42
    if ((x & CLOSE) !== 0) {
      const st = isStar ? starSt : undSt
      const base = isStar ? 0 : 6
      for (;;) {
        const lenT = aRe[t] - aRs[t]
        const cidx = base + (lenT % 3) * 2 + ((x & OPEN) !== 0 ? 1 : 0)
        const sl = isStar ? starLen : undLen
        let found = -1, lenO = 0
        for (let j = sl - 1; j >= bot[cidx]; j--) {
          const o = st[j]
          lenO = aRe[o] - aRs[o]
          if (((tX[o] & CLOSE) !== 0 || (x & OPEN) !== 0) && lenT % 3 !== 0 && (lenO + lenT) % 3 === 0) continue
          found = j
          break
        }
        if (found < 0) { bot[cidx] = sl; break }
        const o = st[found]
        const use = (lenO > 1 && lenT > 1) ? 2 : 1
        addMatch(use, o, t)
        // everything above the opener is inside the pair: drop it (both stacks)
        if (isStar) {
          starLen = found + 1
          while (undLen > 0 && undSt[undLen - 1] > o) undLen--
        } else {
          undLen = found + 1
          while (starLen > 0 && starSt[starLen - 1] > o) starLen--
        }
        for (let q = 0; q < 12; q++) {
          const lim = q < 6 ? starLen : undLen
          if (bot[q] > lim) bot[q] = lim
        }
        const bi = isStar ? 0 : 6
        for (let q = bi; q < bi + 6; q++) if (bot[q] > found) bot[q] = found
        aRe[o] -= use
        aRs[t] += use
        if (aRe[o] === aRs[o]) { if (isStar) starLen--; else undLen-- }
        // re-resolve what lies strictly between opener and closer
        let qa = pendA.length
        while (qa > 0 && pendA[qa - 1] > o) qa--
        let qs = pendS.length
        while (qs > 0 && pendS[qs - 1] > o) qs--
        if (qa < pendA.length || qs < pendS.length) {
          const bA = pendA.splice(qa), bS = pendS.splice(qs)
          let w = 0
          for (let q = 0; q < bA.length; q++) if (aRe[bA[q]] > aRs[bA[q]]) bA[w++] = bA[q]
          bA.length = w
          resolveSeqs(bA, 0, w, bS, 0, bS.length, false)
        }
        if (aRs[t] === aRe[t]) break
      }
    }
    if ((x & OPEN) !== 0 && aRe[t] > aRs[t]) {
      if (isStar) starSt[starLen++] = t; else undSt[undLen++] = t
    }
    if (aRe[t] > aRs[t]) pendA.push(t)
  }
  if (sArr !== null) {
    while (si < s1) pendS.push(sArr[si++])
    if (pendS.length) stkPair(pendS, 0, pendS.length, null, 0, 0)
  }
}

function stkPair(arr, lo, hi, aArr, a0, a1) {
  const sk1 = [], sk2 = []
  let sk1Len = 0, sk2Len = 0
  const pendA = []
  let ai = a0
  for (let k = lo; k < hi; k++) {
    const t = arr[k]
    if (aArr !== null) while (ai < a1 && aArr[ai] < t) pendA.push(aArr[ai++])
    const x = tX[t]
    const one = tE[t] - tS[t] === 1
    if ((x & CLOSE) !== 0) {
      const sl = one ? sk1Len : sk2Len
      if (sl > 0) {
        const o = (one ? sk1 : sk2)[sl - 1]
        const m = newMatch(0)
        mNO[m] = -1; mNC[m] = -1
        aOH[o] = m; aCH[t] = m
        if (one) sk1Len = sl - 1; else sk2Len = sl - 1
        while (sk1Len > 0 && sk1[sk1Len - 1] > o) sk1Len--
        while (sk2Len > 0 && sk2[sk2Len - 1] > o) sk2Len--
        if (pendA.length > 0 && pendA[pendA.length - 1] > o) {
          let q = pendA.length
          while (q > 0 && pendA[q - 1] > o) q--
          const batch = pendA.splice(q)
          attPair(batch, 0, batch.length, null, 0, 0)
        }
        continue
      }
    }
    if ((x & OPEN) !== 0) { if (one) sk1[sk1Len++] = t; else sk2[sk2Len++] = t }
  }
  if (aArr !== null) {
    while (ai < a1) pendA.push(aArr[ai++])
    if (pendA.length) attPair(pendA, 0, pendA.length, null, 0, 0)
  }
}

// ---------------------------------------------------------------- gfm autolink literals
function emailStart(i) {
  const c = T.charCodeAt(i)
  if (!gatext(c)) return false
  if (lsTop > 0) return false
  if (i > start0) {
    const p = T.charCodeAt(i - 1)
    if (p === 47 || gatext(p)) return false
  }
  return true
}
function emailAt(i) {
  let j = i
  while (gatext(at(j))) j++
  if (at(j) !== 64) return -1
  j++
  let data = false, dot = false
  for (;;) {
    const c = at(j)
    if (c === 46) {
      if (isAlnum(at(j + 1))) { j++; dot = true; continue }
      break
    }
    if (c === 45 || c === 95 || isAlnum(c)) { data = true; j++; continue }
    break
  }
  if (data && dot && isAlpha(T.charCodeAt(j - 1))) return j
  return -1
}

function isWsOrEol(c) { return c === 9 || c === 10 || c === 13 || c === 32 }
// Is the rest of the literal only trailing punctuation? Memoised per position (state 0 results are
// position-only), which keeps floods of punctuation linear.
let trailMemo = new Int8Array(1024), trailInit = false
const trailVis = []
function trailOk(j) {
  if (!trailInit) {
    const need = n - start0 + 2
    if (trailMemo.length < need) trailMemo = new Int8Array(need * 2)
    trailMemo.fill(0, 0, need)
    trailInit = true
  }
  let st = 0, res = false, vl = 0
  for (;;) {
    if (st === 0) {
      const m = trailMemo[j - start0]
      if (m !== 0) { res = m === 1; break }
      trailVis[vl++] = j
    }
    const c = at(j)
    if (st === 0) {
      if (c === 33 || c === 34 || c === 39 || c === 41 || c === 42 || c === 44 || c === 46 || c === 58 || c === 59 || c === 63 || c === 95 || c === 126) { j++; continue }
      if (c === 38) { j++; st = 2; continue }
      if (c === 93) { j++; st = 1; continue }
      res = c === 60 || c === -1 || cls(c) === 1
      break
    } else if (st === 1) {
      if (c === -1 || c === 40 || c === 91 || cls(c) === 1) { res = true; break }
      st = 0
      continue
    } else if (st === 2) {
      if (isAlpha(c)) { st = 3; continue }
      res = false
      break
    } else {
      if (c === 59) { j++; st = 0; continue }
      if (isAlpha(c)) { j++; continue }
      res = false
      break
    }
  }
  const v = res ? 1 : 2
  for (let q = 0; q < vl; q++) trailMemo[trailVis[q] - start0] = v
  return res
}
function domainEnd(j) {
  let us1 = false, us2 = false, seen = false
  for (;;) {
    const c = at(j)
    if (c === 46 || c === 95) {
      if (trailOk(j)) break
      if (c === 95) us1 = true
      else { us2 = us1; us1 = false }
      j++
      continue
    }
    if (c === -1 || cls(c) === 1 || (c !== 45 && cls(c) === 2)) break
    seen = true
    j++
  }
  if (us2 || us1 || !seen) return -1
  return j
}
function pathEnd(j) {
  let open = 0, close = 0
  for (;;) {
    const c = at(j)
    if (c === 40) { open++; j++; continue }
    if (c === 41 && close < open) { close++; j++; continue }
    if (c === 33 || c === 34 || c === 38 || c === 39 || c === 41 || c === 42 || c === 44 || c === 46 || c === 58 || c === 59 || c === 60 || c === 63 || c === 93 || c === 95 || c === 126) {
      if (trailOk(j)) return j
      if (c === 41) close++
      j++
      continue
    }
    if (c === -1 || cls(c) === 1) return j
    j++
  }
}
function wwwAt(i) {
  const prev = i > start0 ? T.charCodeAt(i - 1) : -1
  if (!(prev === -1 || prev === 40 || prev === 42 || prev === 95 || prev === 91 || prev === 93 || prev === 126 || isWsOrEol(prev))) return -1
  if ((at(i + 1) | 32) !== 119 || (at(i + 2) | 32) !== 119 || at(i + 3) !== 46 || i + 4 >= n) return -1
  const d = domainEnd(i)
  if (d < 0) return -1
  return pathEnd(d)
}
function protocolAt(i) {
  const prev = i > start0 ? T.charCodeAt(i - 1) : -1
  if (prev !== -1 && isAlpha(prev)) return -1
  if ((at(i + 1) | 32) !== 116 || (at(i + 2) | 32) !== 116 || (at(i + 3) | 32) !== 112) return -1
  let j = i + 4
  if ((at(j) | 32) === 115 && at(j) !== -1) j++
  if (at(j) !== 58 || at(j + 1) !== 47 || at(j + 2) !== 47) return -1
  j += 3
  const c = at(j)
  if (c === -1 || c < 32 || c === 127 || cls(c) !== 0) return -1
  const d = domainEnd(j)
  if (d < 0) return -1
  return pathEnd(d)
}

// ---------------------------------------------------------------- build
const fNode = [], fCur = [], fKind = []
let fTop = 0
let cur = []

// A text run is a maximal sequence of consecutive text pieces; contiguous raw pieces of T are only
// materialised once (no per-piece garbage). flushRun() turns the run into one text node.
let runOn = false, runStart = 0, runVal = '', rawA = 0, rawB = 0, runEndI = 0, runEndPt = null
function addRaw(a, b, endPt) {
  if (b <= a) return
  if (runOn) {
    if (rawB === a && rawB > rawA) rawB = b
    else { if (rawB > rawA) runVal += T.slice(rawA, rawB); rawA = a; rawB = b }
  } else { runOn = true; runStart = a; runVal = ''; rawA = a; rawB = b }
  runEndI = b; runEndPt = endPt === undefined ? null : endPt
}
function addVal(a, b, v, endPt) {
  if (runOn) {
    if (rawB > rawA) runVal += T.slice(rawA, rawB)
    runVal += v
  } else { runOn = true; runStart = a; runVal = v }
  rawA = rawB = 0
  runEndI = b; runEndPt = endPt === undefined ? null : endPt
}
function flushRun() {
  if (!runOn) return
  runOn = false
  const val = rawB > rawA ? (runVal === '' ? T.slice(rawA, rawB) : runVal + T.slice(rawA, rawB)) : runVal
  cur.push({type: 'text', value: val, position: {start: ptS(runStart), end: runEndPt !== null ? runEndPt : ptE(runEndI)}})
}
function pushN(node) { if (runOn) flushRun(); cur.push(node) }
function text(s, e) { addRaw(s, e) }

function enterNode(m, a) {
  const u = mUse[m]
  const node = {type: u === 0 ? 'delete' : u === 1 ? 'emphasis' : 'strong', children: [], position: {start: ptS(a), end: undefined}}
  pushN(node)
  fNode[fTop] = node; fCur[fTop] = cur; fKind[fTop] = 0; fTop++
  cur = node.children
}
function exitNode(b) {
  if (runOn) flushRun()
  fTop--
  fNode[fTop].position.end = ptE(b)
  cur = fCur[fTop]
}

function toStr(nodes) {
  let out = ''
  const stackL = [nodes], stackI = [0]
  while (stackL.length) {
    const top = stackL.length - 1
    const list = stackL[top]
    const i = stackI[top]
    if (i >= list.length) { stackL.pop(); stackI.pop(); continue }
    stackI[top] = i + 1
    const nd = list[i]
    if (nd.value !== undefined) out += nd.value
    else if (nd.alt) out += nd.alt
    else if (nd.children) { stackL.push(nd.children); stackI.push(0) }
  }
  return out
}

function build() {
  cur = []
  fTop = 0
  runOn = false
  let pos = start0 + taskLen
  let skipEol = false
  for (let t = 0; t < nt; t++) {
    const k = tKind[t]
    const s = tS[t], e = tE[t]
    if (k === K_EOL) {
      if (skipEol) { skipEol = false; pos = tX[t]; continue }
      // trailing whitespace of the data before the line ending
      let w = 0, tabs = false
      let q = s
      while (q > pos) {
        const d = T.charCodeAt(q - 1)
        if (d === 32) { w++; q-- } else if (d === 9) { w++; tabs = true; q-- } else break
      }
      if (w > 0) {
        text(pos, q)
        if (!tabs && w >= 2) {
          pushN({type: 'break', position: {start: ptS(q), end: ptEol(e, tO[t])}})
          pos = tX[t]
          continue
        }
      } else text(pos, s)
      addRaw(s, e, ptEol(e, tO[t]))
      pos = tX[t]
      continue
    }
    if (s > pos) text(pos, s)
    switch (k) {
      case K_ESC: addVal(s, e, T[s + 1]); break
      case K_REF: addVal(s, e, tO[t]); break
      case K_TEXT: text(s, e); break
      case K_BRKESC: {
        // always followed by its line ending
        const eolEnd = tE[t + 1]
        pushN({type: 'break', position: {start: ptS(s), end: ptEol(eolEnd, tO[t + 1])}})
        skipEol = true
        break
      }
      case K_CODE: {
        let v = T.slice(tX[t], tO[t])
        if (inTable && v.indexOf('\\') !== -1) v = v.replace(/\\([\\|])/g, (a, b) => b === '|' ? b : a)
        pushN({type: 'inlineCode', value: v, position: {start: ptS(s), end: ptE(e)}})
        break
      }
      case K_MATH: {
        const v = T.slice(tX[t], tO[t])
        pushN({
          type: 'inlineMath', value: v,
          data: {hName: 'code', hProperties: {className: ['language-math', 'math-inline']}, hChildren: [{type: 'text', value: v}]},
          position: {start: ptS(s), end: ptE(e)}
        })
        break
      }
      case K_HTML:
        pushN({type: 'html', value: htmlValue(s, e), position: {start: ptS(s), end: ptE(e)}})
        break
      case K_AUTO: {
        const ps = tO[t], pe = e - 1
        const v = T.slice(ps, pe)
        pushN({
          type: 'link', title: null, url: tX[t] === 1 ? 'mailto:' + v : v,
          children: [{type: 'text', value: v, position: {start: ptS(ps), end: ptE(pe)}}],
          position: {start: ptS(s), end: ptE(e)}
        })
        break
      }
      case K_LIT: {
        const v = T.slice(s, e)
        const ty = tX[t]
        pushN({
          type: 'link', title: null, url: ty === 0 ? v : ty === 1 ? 'http://' + v : 'mailto:' + v,
          children: [{type: 'text', value: v, position: {start: ptS(s), end: ptE(e)}}],
          position: {start: ptS(s), end: ptE(e)}
        })
        break
      }
      case K_FOOT: {
        const raw = tO[t]
        pushN({
          type: 'footnoteReference', identifier: normalizeIdentifier(raw).toLowerCase(), label: dec(raw),
          position: {start: ptS(s), end: ptE(e)}
        })
        break
      }
      case K_ATT: {
        let p = s
        for (let m = aCH[t]; m !== -1; m = mNC[m]) { exitNode(p + mUse[m]); p += mUse[m] }
        const re = aRe[t]
        if (re > p) text(p, re)
        let q = re
        for (let m = aOH[t]; m !== -1; m = mNO[m]) { enterNode(m, q); q += mUse[m] }
        break
      }
      case K_STK: {
        if (aCH[t] !== -1) exitNode(e)
        else if (aOH[t] !== -1) enterNode(aOH[t], s)
        else text(s, e)
        break
      }
      case K_LSTART: case K_ISTART: text(s, e); break
      case K_LINK_OPEN: {
        const node = {type: 'link', title: null, url: '', children: [], position: {start: ptS(s), end: undefined}}
        pushN(node)
        fNode[fTop] = node; fCur[fTop] = cur; fKind[fTop] = 1; fTop++
        cur = node.children
        break
      }
      case K_IMG_OPEN: {
        const node = {type: 'image', title: null, url: '', alt: null, position: {start: ptS(s), end: undefined}}
        pushN(node)
        fNode[fTop] = node; fCur[fTop] = cur; fKind[fTop] = 2; fTop++
        cur = []
        break
      }
      case K_GROUP_CLOSE: {
        const p = tO[t]
        if (runOn) flushRun()
        fTop--
        const node = fNode[fTop]
        const kind = fKind[fTop]
        const children = cur
        cur = fCur[fTop]
        node.position.end = ptE(e)
        if (p.rtype === 0) {
          node.url = p.url; node.title = p.title
          if (kind === 1) node.children = children
          else node.alt = toStr(children)
        } else {
          const raw = T.slice(p.ls, p.le)
          if (kind === 1) {
            node.type = 'linkReference'
            delete node.url; delete node.title
            node.children = children
          } else {
            node.type = 'imageReference'
            delete node.url; delete node.title
            node.alt = toStr(children)
          }
          node.referenceType = p.rtype === 1 ? 'shortcut' : p.rtype === 2 ? 'collapsed' : 'full'
          node.identifier = normalizeIdentifier(raw).toLowerCase()
          node.label = dec(raw)
        }
        break
      }
    }
    pos = e
  }
  // trailing data at the end of the stream
  {
    let q = n
    while (q > pos) {
      const d = T.charCodeAt(q - 1)
      if (d === 32 || d === 9) q--; else break
    }
    text(pos, q)
  }
  if (runOn) flushRun()
  return cur
}

// ---------------------------------------------------------------- mdast-util-gfm-autolink-literal transform
function unicodeWsOrPunct(code) {
  return code >= 0 && code < 65536 && CLS[code] !== 0
}
function prevOk(match, email) {
  const code = match.input.charCodeAt(match.index - 1)
  return (match.index === 0 || (code >= 0 && CLS[code] === 1) || (code >= 0 && CLS[code] === 2)) && (!email || code !== 47)
}
function isCorrectDomain(domain) {
  const parts = domain.split('.')
  if (
    parts.length < 2 ||
    (parts[parts.length - 1] && (/_/.test(parts[parts.length - 1]) || !/[a-zA-Z\d]/.test(parts[parts.length - 1]))) ||
    (parts[parts.length - 2] && (/_/.test(parts[parts.length - 2]) || !/[a-zA-Z\d]/.test(parts[parts.length - 2])))
  ) return false
  return true
}
function splitUrl(url) {
  const trailExec = /[!"&'),.:;<>?\]}]+$/.exec(url)
  if (!trailExec) return [url, undefined]
  url = url.slice(0, trailExec.index)
  let trail = trailExec[0]
  let closingParenIndex = trail.indexOf(')')
  const openingParens = ccount(url, '(')
  let closingParens = ccount(url, ')')
  while (closingParenIndex !== -1 && openingParens > closingParens) {
    url += trail.slice(0, closingParenIndex + 1)
    trail = trail.slice(closingParenIndex + 1)
    closingParenIndex = trail.indexOf(')')
    closingParens++
  }
  return [url, trail]
}
const URL_RE = /(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/gi
const EMAIL_RE = /(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu
function findUrl(_, protocol, domain, path, match) {
  let prefix = ''
  if (!prevOk(match, false)) return false
  if (/^w/i.test(protocol)) { domain = protocol + domain; protocol = ''; prefix = 'http://' }
  if (!isCorrectDomain(domain)) return false
  const parts = splitUrl(domain + path)
  if (!parts[0]) return false
  const result = {type: 'link', title: null, url: prefix + protocol + parts[0], children: [{type: 'text', value: protocol + parts[0]}]}
  if (parts[1]) return [result, {type: 'text', value: parts[1]}]
  return result
}
function findEmail(_, atext, label, match) {
  if (!prevOk(match, true) || /[-\d_]$/.test(label)) return false
  return {type: 'link', title: null, url: 'mailto:' + atext + '@' + label, children: [{type: 'text', value: atext + '@' + label}]}
}
function applyFind(re, replace, value) {
  re.lastIndex = 0
  let match = re.exec(value)
  if (match === null) return null
  let start = 0, change = false
  const nodes = []
  const add = child => {
    const prev = nodes[nodes.length - 1]
    if (prev && prev.type === 'text' && child.type === 'text') prev.value += child.value
    else nodes.push(child)
  }
  while (match) {
    const position = match.index
    const mo = {index: match.index, input: match.input}
    const v = replace(...match, mo)
    if (v === false) re.lastIndex = position + 1
    else {
      if (start !== position) add({type: 'text', value: value.slice(start, position)})
      if (Array.isArray(v)) for (const c of v) add(c)
      else if (v) add(v)
      start = position + match[0].length
      change = true
    }
    match = re.exec(value)
  }
  if (!change) return null
  if (start < value.length) add({type: 'text', value: value.slice(start)})
  return nodes
}
function transformText(node) {
  let nodes = null
  const v = node.value
  if (v.indexOf('://') !== -1 || /www\./i.test(v)) nodes = applyFind(URL_RE, findUrl, v)
  if (v.indexOf('@') !== -1) {
    if (nodes === null) nodes = applyFind(EMAIL_RE, findEmail, v)
    else {
      const out = []
      for (const nd of nodes) {
        if (nd.type === 'text' && nd.value.indexOf('@') !== -1) {
          const r = applyFind(EMAIL_RE, findEmail, nd.value)
          if (r === null) out.push(nd); else for (const x of r) out.push(x)
        } else out.push(nd)
      }
      nodes = out
    }
  }
  return nodes
}
// iterative (mdast nesting can be very deep): visit text nodes outside link/linkReference
function transformList(root) {
  const stackL = [root], stackI = [0]
  while (stackL.length) {
    const top = stackL.length - 1
    const children = stackL[top]
    let i = stackI[top]
    if (i >= children.length) { stackL.pop(); stackI.pop(); continue }
    const nd = children[i]
    stackI[top] = i + 1
    if (nd.type === 'text') {
      const r = transformText(nd)
      if (r !== null) { children.splice(i, 1, ...r); stackI[top] = i + r.length }
    } else if (nd.type === 'link' || nd.type === 'linkReference') continue
    else if (nd.children && nd.children.length) { stackL.push(nd.children); stackI.push(0) }
  }
}

// ---------------------------------------------------------------- drivers
// prescan: does the range [a, b) of T contain anything that needs the slow path?
function special(a, b) {
  for (let i = a; i < b; i++) {
    const c = T.charCodeAt(i)
    if (c >= 128) continue
    const k = LUT[c]
    if (k === 0) { if (c === 64 || (mathOn && c === 36)) return true; continue }
    if (k === S_H) { if ((T.charCodeAt(i + 1) | 32) === 116) return true; continue }
    if (k === S_W) { if ((T.charCodeAt(i + 1) | 32) === 119) return true; continue }
    return true
  }
  return false
}

function finishTask(children, node) {
  const head = children[0]
  if (head && head.type === 'text') {
    head.value = head.value.slice(1)
    if (head.value.length === 0) children.shift()
    else {
      head.position.start.column++
      head.position.start.offset++
      node.position.start = Object.assign({}, head.position.start)
    }
  }
}

// single-line content: src[cs, ce) on line `line` whose first char offset is `ls`
export function inlineSingle(node, line, ls, cs, ce, table, task) {
  if (trackDefs) { runNeg.length = 0; runPos.length = 0 }
  T = SRC; n = ce; start0 = cs
  single = true; Lline = line; Lls = ls
  inTable = table
  taskLen = task === 1 || task === 2 ? 3 : task === 11 || task === 12 ? 4 : 0; taskCand = task === 3
  if (!special(cs, ce) && !task) {
    let e = ce
    while (e > cs) { const d = T.charCodeAt(e - 1); if (d === 32 || d === 9) e--; else break }
    node.children = e > cs ? [{type: 'text', value: T.slice(cs, e), position: {start: {line, column: cs - ls + 1, offset: cs}, end: {line, column: e - ls + 1, offset: e}}}] : []
    return
  }
  scan()
  resolveSeqs(attL, 0, na, stkL, 0, nsk, firstSeq === 1)
  const children = build()
  if (task === 1 || task === 11) finishTask(children, node)
  transformList(children)
  node.children = children
}

// multi-line content: lines = [line, ls, cs, ce] * k  (cs is the chunk start: first line content start,
// later lines start after the container prefix, keeping indentation)
export function inlineMulti(node, lines, task) {
  if (trackDefs) { runNeg.length = 0; runPos.length = 0 }
  const k = lines.length / 5
  let s = ''
  nck = k
  for (let i = 0; i < k; i++) {
    const ce = lines[i * 5 + 3], cs = lines[i * 5 + 2], vl = lines[i * 5 + 4]
    ckT[i] = s.length; ckSrc[i] = cs; ckV[i] = vl; ckLine[i] = lines[i * 5]; ckLs[i] = lines[i * 5 + 1]
    if (vl > 0) s += ' '.repeat(vl)
    if (i < k - 1) {
      const c = SRC.charCodeAt(ce)
      const el = (c === 13 && SRC.charCodeAt(ce + 1) === 10) ? 2 : 1
      s += SRC.slice(cs, ce + el)
    } else s += SRC.slice(cs, ce)
  }
  T = s; n = s.length; start0 = 0
  single = false
  inTable = false
  taskLen = task === 1 || task === 2 ? 3 : task === 11 || task === 12 ? 4 : 0; taskCand = task === 3
  scan()
  resolveSeqs(attL, 0, na, stkL, 0, nsk, firstSeq === 1)
  const children = build()
  if (task === 1 || task === 11) finishTask(children, node)
  transformList(children)
  node.children = children
}
