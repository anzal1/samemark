// Hand-written CommonMark + GFM block parser producing mdast (block structure only).
// Phrasing containers (paragraph, heading, tableCell) get children: [].
import {normalizeIdentifier} from 'micromark-util-normalize-identifier'
import {decodeString} from 'micromark-util-decode-string'
import {htmlBlockNames} from 'micromark-util-html-tag-name'
import {inlineSingle, inlineMulti, setSource, setDefinitions, setMath, setTrackDefs, takeNeeds} from './inline.js'

const BLOCK_NAMES = new Set(htmlBlockNames)

const ROOT = 0, BQ = 1, LIST = 2, ITEM = 3, FN = 4
const NONE = 0, PARA = 1, ICODE = 2, FCODE = 3, HTML = 4, TABLE = 5

let src = '', len = 0, hasCR = false
let ls = 0, le = 0, eolLen = 0, lineNo = 0
let pos = 0, col = 0, vleft = 0
let stk = [], sp = 0
let ns = 0, indent = 0, blank = false
let e1Line = 1, e1Ls = 0, e1Off = 0
let lineTok = false, lineCont = false, lastBq = 0, bqIdx = 0
let e2Line = 1, e2Ls = 0, e2Off = 0, ebLine = 0, ebLs = 0, ebOff = 0, ebBi = 0
let pendingBlank = false, pbCi = 0, pbBq = false
let failKind = -1
let root = null

// leaf state
let leaf = NONE
// paragraph
let pL = 0, pLs = 0, pOff = 0, eL = 0, eLs = 0, eOff = 0, pCand = false
let pLines = [], pPos = [], pVl = []
// phrasing containers whose children are filled in after the block pass (definitions may follow use)
let emptyItemLine = -1
// streaming bookkeeping (parseStream)
let streamOn = false, streamSafe = null, streamEntries = []
const defLog = [], fnLog = [], rcLog = []
let initDefs = null, initFns = null
function topNow() { return root.children.length - 1 }
let mathOn = false
// indented code that started on a line that closed containers (micromark: its flow is not `interrupt`ible)
let icClosed = false
let pend = [], defIds = new Set(), fnIds = new Set(), doInline = true
// code / html
let cL = 0, cLs = 0, cOff = 0, cVal = '', cN = 0, cLastL = 0, cLastLs = 0, cLastLe = 0, cEol = ''
let fEolCR = false
let fch = 0, flen = 0, findent = 0, flang = null, fmeta = null
let hkind = 0
let icPend = ''
// table
let tNode = null, tState = 0, tSize = 0

function P(line, lsv, off) {
  return {line, column: off - lsv + 1, offset: off}
}

function cont(kind, node) {
  return {kind, node, cc: 0, sb: false, fb: false, ord: false, mk: 0}
}

// ---- cursor helpers ----
function findNS() {
  let i = pos
  let c = col + vleft
  const base = col
  while (i < le) {
    const ch = src.charCodeAt(i)
    if (ch === 32) { i++; c++ } else if (ch === 9) { c += 4 - (c & 3); i++ } else break
  }
  ns = i
  indent = c - base
  blank = i >= le
}

// like findNS but stops once `lim` columns of whitespace were seen (keeps per-container
// matching O(consumed columns) instead of rescanning the whole indentation run).
// When truncated, `blank` is reported false even if only whitespace follows.
function findNSL(lim) {
  let i = pos
  let c = col + vleft
  const base = col
  while (i < le && c - base < lim) {
    const ch = src.charCodeAt(i)
    if (ch === 32) { i++; c++ } else if (ch === 9) { c += 4 - (c & 3); i++ } else break
  }
  ns = i
  indent = c - base
  blank = i >= le
}

// consume n virtual columns
function advance(n) {
  while (n > 0) {
    if (vleft > 0) {
      const t = vleft < n ? vleft : n
      vleft -= t; col += t; n -= t
      continue
    }
    if (src.charCodeAt(pos) === 9) {
      const w = 4 - (col & 3)
      pos++
      if (n >= w) { col += w; n -= w } else { vleft = w - n; col += n; n = 0 }
    } else {
      pos++; col++; n--
    }
  }
}

function eolStr(at, n) {
  if (n === 1) return src.charCodeAt(at) === 10 ? '\n' : '\r'
  return n === 2 ? '\r\n' : ''
}

function restOfLine() {
  return vleft > 0 ? ' '.repeat(vleft) + src.slice(pos, le) : src.slice(pos, le)
}

// ---- container closing ----
let listSeen = false
function closeContainers(to) {
  listSeen = false
  while (sp > to) {
    const c = stk[--sp]
    stk[sp] = null
    if (c.kind === ITEM) {
      const ch = c.node.children
      const last = ch.length ? ch[ch.length - 1].type : ''
      // closed right after a container prefix: an item that is empty or ends in a container exits there too
      c.node.position.end = closeOver && (closeFn || last === 'list' || last === 'blockquote' || (e12Line === lineNo && (last === 'code' || last === 'html' || last === 'math'))) ? closeOver() : last === 'list' && e1Line > e2Line && bqRun > 0 ? P(e1Line, e1Ls, e1Off) : pickE2(sp)
    } else {
      c.node.position.end = P(e1Line, e1Ls, e1Off)
      if (c.kind === LIST) { if (bqRun >= 2 && !listSeen) c.node.spread = true; listSeen = true }
    }
  }
}

function setE1(l, lsv, off) { e1Line = l; e1Ls = lsv; e1Off = off }
// the last token of an unclosed fence / html block is the code itself: containers end where it ends
let cRealL = 0, cRealLs = 0, cRealLe = 0
function setE12(end) {
  if (end.line > cRealL) e12Line = lineNo
  if (cRealLe > end.offset) end = P(cRealL, cRealLs, cRealLe)
  const lsv = end.offset - end.column + 1
  e1Line = end.line; e1Ls = lsv; e1Off = end.offset
  e2Line = end.line; e2Ls = lsv; e2Off = end.offset
}

// ---- leaf closing ----
function parentChildren() { return stk[sp - 1].node.children }

function closeLeaf(eolIncluded) {
  switch (leaf) {
    case NONE: return
    case PARA: leaf = NONE; finishParagraph(-1); return
    case ICODE: leaf = NONE; icPend = ''; finishICode(); return
    case FCODE: leaf = NONE; finishFCode(false, eolIncluded); return
    case HTML: leaf = NONE; finishHtml(eolIncluded); return
    case TABLE: leaf = NONE; finishTable(); return
  }
}

function finishICode() {
  let v = cVal
  const lc = v.charCodeAt(v.length - 1)
  if (lc === 10) v = v.slice(0, v.length - (v.charCodeAt(v.length - 2) === 13 ? 2 : 1))
  else if (lc === 13) v = v.slice(0, -1)
  const node = {
    type: 'code', lang: null, meta: null, value: v,
    position: {start: P(cL, cLs, cOff), end: P(cLastL, cLastLs, cLastLe)}
  }
  parentChildren().push(node)
}

function endOfCode(eolIncluded, eof) {
  if (eolIncluded && eof) {
    // end of document
    if (eolLenAtEof > 0) return P(lineNo + 1, len, len)
    return P(cLastL, cLastLs, cLastLe)
  }
  if (eolIncluded) return P(lineNo, ls, ls)
  return P(cLastL, cLastLs, cLastLe)
}
let eolLenAtEof = 0

function finishFCode(closed, eolIncluded, eof) {
  let val = cVal
  let end
  if (closed) {
    end = P(cLastL, cLastLs, cLastLe)
  } else {
    end = endOfCode(eolIncluded, eof)
    if (!eolIncluded) {
      const c = val.charCodeAt(val.length - 1)
      if (c === 10) val = val.slice(0, val.length - (val.charCodeAt(val.length - 2) === 13 ? 2 : 1))
      else if (c === 13) val = val.slice(0, -1)
    }
    setE12(end)
  }
  // micromark strips `^(\r?\n|\r)` from the data: a lone-CR opening EOL followed by an LF-terminated empty first line
  // reads as one CRLF; the same at the end (content ending in CR, then the LF before the closing fence)
  if (fEolCR && val.charCodeAt(0) === 10) val = val.slice(1)
  if (closed && val.charCodeAt(val.length - 1) === 13 && cEol === '\n') val = val.slice(0, -1)
  if (fch === 36) {
    parentChildren().push({
      type: 'math', meta: fmeta, value: val,
      data: {hName: 'pre', hChildren: [{type: 'element', tagName: 'code', properties: {className: ['language-math', 'math-display']}, children: [{type: 'text', value: val}]}]},
      position: {start: P(cL, cLs, cOff), end}
    })
    return
  }
  parentChildren().push({
    type: 'code', lang: flang, meta: fmeta, value: val,
    position: {start: P(cL, cLs, cOff), end}
  })
}

function finishHtml(eolIncluded, eof) {
  let val = cVal
  let end
  if (eolIncluded && hkind <= 5) {
    end = endOfCode(true, eof)
    if (end.offset !== cLastLe) {
      val += cEolHtml()
      setE12(end)
    }
  } else end = P(cLastL, cLastLs, cLastLe)
  parentChildren().push({
    type: 'html', value: val,
    position: {start: P(cL, cLs, cOff), end}
  })
}

function finishTable() {
  tNode = null
}

// ---- paragraph / definitions ----
function isWs(c) { return c === 32 || c === 9 }

function paragraphHasContentAfterDefs() {
  if (!pCand) return true
  return finishParagraph(-2)
}

// Is there a ']:' in [from, to)? Cached next-occurrence so the total scan is
// linear over the document (paragraphs are visited in increasing offset order).
let dm = -2
function defMarkerIn(from, to) {
  if (dm === -2 || (dm !== -1 && dm < from)) dm = src.indexOf(']:', from)
  return dm !== -1 && dm < to
}

// mode -1: emit; -2: dry-run returning whether paragraph content remains
function finishParagraph(mode, heading) {
  let startL = pL, startLs = pLs, startOff = pOff
  const out = mode === -2 ? null : parentChildren()
  let remainingFrom = 0 // index of first remaining line in pLines (4 numbers per line)
  const nBefore = out === null ? 0 : out.length
  if (pCand && defMarkerIn(pOff, eOff)) {
    const r = extractDefs(out)
    if (r === -1) { // all consumed
      if (mode === -2) return false
      pLines.length = 0; pPos.length = 0; pVl.length = 0
      return false
    }
    remainingFrom = r
    if (r > 0) {
      startL = pLines[r]; startLs = pLines[r + 1]; startOff = pLines[r + 2]
    }
  }
  if (mode === -2) return true
  const posn = {start: P(startL, startLs, startOff), end: undefined}
  let node
  let task = false
  if (heading) {
    posn.start = P(pL, pLs, pOff)
    posn.end = heading.end
    node = {type: 'heading', depth: heading.depth, children: [], position: posn}
    out.push(node)
  } else {
    posn.end = P(eL, eLs, eOff)
    const parent = stk[sp - 1]
    // extra whitespace before the content on a later line is a linePrefix token: micromark then does not
    // treat the text as the first content of the item
    const fi = remainingFrom >> 2
    const prefixed = parent.kind === ITEM && startL > parent.node.position.start.line && (startOff > pPos[fi] || pVl[fi] > 0)
    // (definitions at the start of the same content do not count: the text after them still starts the chunk)
    if (parent.kind === ITEM && nBefore === 0 && src.charCodeAt(startOff) === 91 && !prefixed) {
      const t = taskCheck(startOff, startLs)
      if (t !== 0) {
        parent.node.checked = t === 1
        task = taskLenOut === 4 ? 11 : 1
      } else task = 3 // candidate: micromark attempts a task check here (matters for EOL positions)
    } else if (startL === emptyItemLine + 1 && src.charCodeAt(startOff) === 91 && startOff === pPos[fi] && pVl[fi] === 0 &&
      !(parent.node.position && parent.node.position.start.line === startL) && !(parent.kind === ITEM && parent.node.position.start.line === emptyItemLine)) {
      // micromark quirk: right after an empty list item (marker directly followed by the EOL) the next
      // paragraph is tokenised as if it were the first content of that item; `checked` lands on its parent
      const t = taskCheck(startOff, startLs)
      if (t !== 0) {
        parent.node.checked = t === 1
        if (streamOn && parent.kind === ROOT) rcLog.push(root.children.length, t === 1)
        task = taskLenOut === 4 ? 12 : 2
      }
    }
    node = {type: 'paragraph', children: [], position: posn}
    out.push(node)
  }
  if (doInline) {
    const nl = (pLines.length - remainingFrom) >> 2
    if (nl === 1) {
      pend.push(node, task, pLines[remainingFrom], pLines[remainingFrom + 1], pLines[remainingFrom + 2], pLines[remainingFrom + 3], null, topNow())
    } else {
      const lines = new Array(nl * 5)
      for (let i = 0; i < nl; i++) {
        const a = remainingFrom + i * 4
        lines[i * 5] = pLines[a]; lines[i * 5 + 1] = pLines[a + 1]
        lines[i * 5 + 2] = i === 0 ? pLines[a + 2] : pPos[(a >> 2)]
        lines[i * 5 + 3] = pLines[a + 3]
        lines[i * 5 + 4] = i === 0 ? 0 : pVl[(a >> 2)]
      }
      pend.push(node, task, 0, 0, 0, 0, lines, topNow())
    }
  }
  pLines.length = 0; pPos.length = 0; pVl.length = 0
  return true
}

// returns 0 none, 1 checked, 2 unchecked
let taskLenOut = 3
function taskCheck(o, ls0) {
  const c1 = src.charCodeAt(o + 1)
  let checked
  taskLenOut = 3
  if (c1 === 120 || c1 === 88) checked = 1
  else if (c1 === 32 || c1 === 10 || c1 === 13) checked = 2
  else if (c1 === 9) {
    // a tab as the value is followed by its remaining virtual spaces unless it is one column wide
    let col = 0
    for (let q = ls0; q < o + 1; q++) col += src.charCodeAt(q) === 9 ? 4 - (col & 3) : 1
    if (4 - (col & 3) !== 1) return 0
    checked = 2
  } else return 0
  let close = o + 2
  if (c1 === 13 && src.charCodeAt(o + 2) === 10) { close = o + 3; taskLenOut = 4 }
  if (src.charCodeAt(close) !== 93) return 0
  const q = close + 1 // after ]
  const c = src.charCodeAt(q)
  if (c === 10 || c === 13) return q < eOff ? checked : 0
  if (c !== 32 && c !== 9) return 0
  // whitespace then non-end
  let i = q + 1
  while (i < len) {
    const d = src.charCodeAt(i)
    if (d === 32 || d === 9) i++
    else break
  }
  if (i >= eOff) return 0
  return checked
}

// returns index into pLines of first remaining line, or -1 if all consumed
function extractDefs(out) {
  const n = pLines.length / 4
  // build text
  let text = ''
  const starts = new Array(n)
  for (let i = 0; i < n; i++) {
    starts[i] = text.length
    const a = i === 0 ? pLines[2] : pPos[i] // continuation lines keep their indentation (label text)
    text += (i ? '\n' : '') + src.slice(a, pLines[i * 4 + 3])
    starts[i] = i ? text.length - (pLines[i * 4 + 3] - a) : 0
  }
  let li = 0 // current line index
  const tl = text.length
  while (li < n) {
    let from = starts[li]
    while (from < tl && isWs(text.charCodeAt(from))) from++
    const r = parseDef(text, from, tl, starts, n, li)
    if (!r) break
    // r: {endIdx, endLine, label, ident, url, title}
    const el = r.endLine
    if (out) {
      defIds.add(r.idU)
      out.push({
        type: 'definition', identifier: r.ident, label: r.label, title: r.title, url: r.url,
        position: {
          start: P(pLines[li * 4], pLines[li * 4 + 1], pLines[li * 4 + 2]),
          end: P(pLines[el * 4], pLines[el * 4 + 1], pLines[el * 4 + 3])
        }
      })
      if (streamOn) defLog.push(r.idU, topNow())
    }
    li = el + 1
  }
  if (li >= n) return -1
  return li * 4
}

// with CR / CRLF line endings the definition text is joined with '\n'; the mdast values keep the raw EOLs
function lineOf(starts, n, idx) { let l = 0; while (l + 1 < n && starts[l + 1] <= idx) l++; return l }
function eolOfLine(L) {
  const e = pLines[L * 4 + 3]
  const c = src.charCodeAt(e)
  return c === 13 ? (src.charCodeAt(e + 1) === 10 ? '\r\n' : '\r') : '\n'
}
function rawEols(str, starts, n, fromIdx) {
  let l = lineOf(starts, n, fromIdx), out = '', a = 0
  for (;;) {
    const k = str.indexOf('\n', a)
    if (k === -1) return out + str.slice(a)
    out += str.slice(a, k) + eolOfLine(l++)
    a = k + 1
  }
}
function parseDef(text, from, tl, starts, n, li) {
  let i = from
  if (text.charCodeAt(i) !== 91) return null
  // label
  i++
  const labelStart = i
  let size = 0, hasData = false
  for (;;) {
    if (i >= tl) return null
    const c = text.charCodeAt(i)
    if (c === 91) return null
    if (c === 93) break
    if (size > 999) return null
    if (c !== 32 && c !== 9 && c !== 10) hasData = true
    size++
    i++
    if (c === 92) {
      const d = text.charCodeAt(i)
      if (d === 91 || d === 92 || d === 93) { i++; size++ }
    }
  }
  if (!hasData) return null
  const rawLabel = text.slice(labelStart, i)
  i++
  if (text.charCodeAt(i) !== 58) return null
  i++
  // whitespace with optional single eol
  i = skipWsEol(text, i, tl)
  // destination
  let url
  const c0 = text.charCodeAt(i)
  if (c0 === 60) {
    i++
    const s = i
    for (;;) {
      if (i >= tl) return null
      const c = text.charCodeAt(i)
      if (c === 10 || c === 60) return null
      if (c === 62) break
      i++
      if (c === 92) { const d = text.charCodeAt(i); if (d === 60 || d === 62 || d === 92) i++ }
    }
    url = text.slice(s, i)
    i++
  } else {
    const s = i
    let depth = 0
    for (;;) {
      if (i >= tl) break
      const c = text.charCodeAt(i)
      if (c === 40) { if (++depth > 32) return null }
      else if (c === 41) { if (depth === 0) break; depth-- }
      else if (c === 32 || c === 9 || c === 10 || c < 32 || c === 127) break
      else if (c === 92) { const d = text.charCodeAt(i + 1); if (d === 40 || d === 41 || d === 92) i++ }
      i++
    }
    if (depth !== 0) return null
    if (i === s) return null
    url = text.slice(s, i)
  }
  const afterDest = i
  // try title
  let title = null, titleStart = 0
  let endIdx = -1
  {
    let j = afterDest
    const j0 = j
    j = skipWsEol(text, j, tl)
    if (j > j0) {
      const q = text.charCodeAt(j)
      if (q === 34 || q === 39 || q === 40) {
        const close = q === 40 ? 41 : q
        let k = j + 1
        let ok = false
        for (;;) {
          if (k >= tl) break
          const c = text.charCodeAt(k)
          if (c === close) { ok = true; break }
          k++
          if (c === 92) { const d = text.charCodeAt(k); if (d === q || d === close || d === 92) k++ }
        }
        if (ok) {
          let m = k + 1
          while (m < tl && isWs(text.charCodeAt(m))) m++
          if (m >= tl || text.charCodeAt(m) === 10) {
            title = k > j + 1 ? text.slice(j + 1, k) : null
            titleStart = j + 1
            endIdx = m
          }
        }
      }
    }
  }
  if (endIdx === -1) {
    let m = afterDest
    while (m < tl && isWs(text.charCodeAt(m))) m++
    if (m >= tl || text.charCodeAt(m) === 10) endIdx = m
    else return null
  }
  // find line of endIdx
  let el = li
  while (el + 1 < n && starts[el + 1] <= endIdx) el++
  let label = rawLabel.indexOf('\\') === -1 && rawLabel.indexOf('&') === -1 ? rawLabel : decodeString(rawLabel)
  if (hasCR && label.indexOf('\n') !== -1) label = rawEols(label, starts, n, labelStart)
  const idU = normalizeIdentifier(rawLabel)
  const ident = idU.toLowerCase()
  if (url.indexOf('\\') !== -1 || url.indexOf('&') !== -1) url = decodeString(url)
  if (title !== null) {
    if (title.indexOf('\n') !== -1) { title = title.replace(/\n[ \t]*/g, '\n'); if (hasCR) title = rawEols(title, starts, n, titleStart) }
    if (title.indexOf('\\') !== -1 || title.indexOf('&') !== -1) title = decodeString(title)
  }
  return {endIdx, endLine: el, label, ident, idU, url, title}
}

function skipWsEol(text, i, tl) {
  while (i < tl && isWs(text.charCodeAt(i))) i++
  if (text.charCodeAt(i) === 10) {
    i++
    while (i < tl && isWs(text.charCodeAt(i))) i++
  }
  return i
}

// ---- main ----
// remark-frontmatter / micromark-extension-frontmatter options -> [{type, open, close}] (same rules as toMatters)
const MARKERS = {yaml: '-', toml: '+'}
export function normalizeMatters(options) {
  const list = Array.isArray(options) ? options : options ? [options] : ['yaml']
  return list.map(o => {
    let m = o
    if (typeof m === 'string') {
      if (!Object.prototype.hasOwnProperty.call(MARKERS, m)) throw new Error('Missing matter definition for `' + m + '`')
      m = {type: m, marker: MARKERS[m]}
    } else if (typeof m !== 'object' || m === null) throw new Error('Expected matter to be an object')
    if (!('type' in m)) throw new Error('Missing `type` in matter')
    const hasFence = 'fence' in m, hasMarker = 'marker' in m
    if (!hasFence && !hasMarker) throw new Error('Missing `marker` or `fence` in matter')
    const pick = (schema, prop) => typeof schema === 'string' ? schema : schema[prop]
    const open = m.marker ? pick(m.marker, 'open').repeat(3) : pick(m.fence, 'open')
    const close = m.marker ? pick(m.marker, 'close').repeat(3) : pick(m.fence, 'close')
    return {type: m.type, open, close, anywhere: Boolean(m.anywhere)}
  })
}

// true when samemark can parse these remark-frontmatter / micromark-extension-frontmatter options natively
// (everything except `anywhere: true`, which needs the real tokenizer)
export function frontmatterSupported(options) {
  try {
    const ms = normalizeMatters(options)
    return ms.length > 0 && ms.every(m => !m.anywhere && m.open.length > 0 && m.close.length > 0)
  } catch { return false }
}

// frontmatter at the very start of the document (micromark: flow construct, line 1 column 1, concrete).
// Returns true (state advanced to the closing fence line) or false.
let noContainers = false
function tryFrontmatter(matters) {
  for (let mi = 0; mi < matters.length; mi++) {
    const m = matters[mi]
    const open = m.open
    if (open.length === 0 || !src.startsWith(open, 0)) continue
    let i = open.length
    while (i < len) { const c = src.charCodeAt(i); if (c === 32 || c === 9) i++; else break }
    if (i >= len) continue
    let c = src.charCodeAt(i)
    if (c !== 10 && c !== 13) continue
    const eol1 = c === 13 && src.charCodeAt(i + 1) === 10 ? 2 : 1
    const bodyStart = i + eol1
    const close = m.close
    // an open fence that never closes is still a pending `concrete` construct while the document is fed:
    // no container (quote, list item, footnote definition) can start on any later line
    noContainers = true
    let pos = bodyStart, line = 2, prevEolLen = eol1
    for (;;) {
      if (pos >= len) break // the line after a trailing EOL is the end of input: not closed
      // end of this line
      let e = pos, eolL = 0
      for (; e < len; e++) {
        const d = src.charCodeAt(e)
        if (d === 10) { eolL = 1; break }
        if (d === 13) { eolL = src.charCodeAt(e + 1) === 10 ? 2 : 1; break }
      }
      // closing fence?
      if (src.startsWith(close, pos)) {
        let j = pos + close.length
        while (j < e) { const d = src.charCodeAt(j); if (d === 32 || d === 9) j++; else break }
        if (j >= e) {
          const value = pos === bodyStart ? '' : src.slice(bodyStart, pos - prevEolLen)
          const node = {type: m.type, value, position: {start: P(1, 0, 0), end: P(line, pos, e)}}
          root.children.push(node)
          lineNo = line; ls = pos; le = e; eolLen = eolL
          lineTok = true; lineCont = true
          setE1(lineNo, ls, le)
          e2Line = lineNo; e2Ls = ls; e2Off = le
          noContainers = false
          return true
        }
      }
      if (eolL === 0) break // content line without EOL at the end of input: not closed
      pos = e + eolL; prevEolLen = eolL; line++
    }
  }
  return false
}

// a Set-like view over a parse's own ids plus ids from earlier (finished) parts of a stream
function composite(a, b) {
  return {has: id => a.has(id) || b.has(id), get size() { return a.size + b.size }}
}

export function parse(source, opts) {
  doInline = !opts || opts.inline !== false
  mathOn = Boolean(opts && opts.math)
  setMath(mathOn, !opts || !opts.math || opts.math.single !== false)
  streamOn = Boolean(opts && opts.stream)
  if (!(opts && opts.tail)) {
    if (source.charCodeAt(0) === 0xfeff) source = source.slice(1)
    if (source.indexOf('\0') !== -1) source = source.replaceAll('\0', '\uFFFD')
  }
  initDefs = (opts && opts.defs) || null; initFns = (opts && opts.fnDefs) || null
  streamSafe = null; streamEntries = []; defLog.length = 0; fnLog.length = 0; rcLog.length = 0
  src = source; len = source.length
  hasCR = source.indexOf('\r') !== -1
  root = {type: 'root', children: [], position: undefined}
  stk = [cont(ROOT, root)]; sp = 1
  leaf = NONE; pendingBlank = false; pCand = false; pLines.length = 0
  e1Line = 1; e1Ls = 0; e1Off = 0
  e2Line = 1; e2Ls = 0; e2Off = 0; ebLine = 0; ebLs = 0; ebOff = 0; ebBi = 0
  quirkItem = null; lateBlank = false; icPend = ''; cVal = ''; tState = 0; dm = -2
  tNode = null
  pend.length = 0; defIds = new Set(); fnIds = new Set(); pPos.length = 0; emptyItemLine = -1; e12Line = -2; bqRun = 0; lastBqBlank = false
  lineNo = 0
  noContainers = false
  let p = 0
  if (opts && opts.frontmatter) {
    if (opts.frontmatter.some(m => m.anywhere)) throw new Error('samemark: frontmatter `anywhere` is not supported natively')
    if (tryFrontmatter(opts.frontmatter)) p = le + eolLen
  }
  while (p < len) {
    ls = p
    if (!hasCR) {
      le = src.indexOf('\n', p)
      if (le === -1) { le = len; eolLen = 0 } else eolLen = 1
    } else {
      let i = p
      for (;;) {
        if (i >= len) { le = len; eolLen = 0; break }
        const c = src.charCodeAt(i)
        if (c === 10) { le = i; eolLen = 1; break }
        if (c === 13) { le = i; eolLen = src.charCodeAt(i + 1) === 10 ? 2 : 1; break }
        i++
      }
    }
    lineNo++
    processLine()
    p = le + eolLen
  }
  // EOF
  eolLenAtEof = eolLen
  const endsEol = len > 0 && (src.charCodeAt(len - 1) === 10 || src.charCodeAt(len - 1) === 13)
  eolLenAtEof = endsEol ? 1 : 0
  let hasBq = false
  for (let i = 1; i < sp; i++) if (stk[i].kind === BQ) hasBq = true
  eofClose(!hasBq)
  if (eolLen === 0 && bqLastLine) { closeOver = () => P(e1Line, e1Ls, e1Off); closeContainers(1); closeOver = null } else closeContainers(1)
  let endP
  if (len === 0) endP = P(1, 0, 0)
  else if (endsEol) endP = P(lineNo + 1, len, len)
  else endP = P(lineNo, ls, len)
  root.position = {start: P(1, 0, 0), end: endP}
  if (doInline && pend.length) {
    setSource(src)
    setDefinitions(initDefs === null ? defIds : composite(defIds, initDefs), initFns === null ? fnIds : composite(fnIds, initFns))
    setTrackDefs(streamOn)
    for (let i = 0; i < pend.length; i += 8) {
      const node = pend[i], task = pend[i + 1], ml = pend[i + 6]
      const tk = task === 1 || task === 2 || task === 3 || task === 11 || task === 12 ? task : 0
      const startLocal = streamOn ? Object.assign({}, node.position.start) : null
      if (ml !== null) inlineMulti(node, ml, tk)
      else inlineSingle(node, pend[i + 2], pend[i + 3], pend[i + 4], pend[i + 5], task === 'table', tk)
      if (streamOn) {
        const nd = takeNeeds()
        if (nd !== null) streamEntries.push({top: pend[i + 7], node, task: tk, table: task === 'table', line: pend[i + 2], ls: pend[i + 3], cs: pend[i + 4], ce: pend[i + 5], ml, startLocal, neg: nd.neg, pos: nd.pos})
      }
    }
    setTrackDefs(false)
    pend.length = 0
  }
  const r = root
  root = null; src = ''
  return r
}

function eofClose(eolOk) {
  switch (leaf) {
    case NONE: return
    case FCODE: leaf = NONE; finishFCode(false, eolOk && eolLenAtEof > 0, true); return
    case HTML: leaf = NONE; finishHtml(eolOk && eolLenAtEof > 0, true); return
    default: closeLeaf(false)
  }
}

function prep(ci, container, eolInc) {
  // close open leaf, pop unmatched containers; pop LIST if non-item child
  closeLeaf(eolInc)
  if (stk[ci].kind === LIST && container) { /* handled by caller */ }
  closeContainers(ci + 1)
}

let lateBlank = false
function attribBlank(ci) {
  let i = ci
  while (i > 0 && stk[i].kind === FN) i--
  const c = stk[i]
  if (c.kind === ITEM) c.node.spread = true
  else if (c.kind === LIST) lateBlank = true
}

function processLine() {
  if (!lastBqBlank) bqRun = 0
  lastBqBlank = false
  pos = ls; col = 0; vleft = 0
  lineTok = false; lineCont = false; lastBq = 0
  lateBlank = false
  failKind = -1
  let d = 1
  let bqLine = false
  let fnLine = false, fnTail = false
  for (; d < sp; d++) {
    const c = stk[d]
    const k = c.kind
    if (k === BQ) {
      findNSL(4)
      if (indent <= 3 && ns < le && src.charCodeAt(ns) === 62) {
        advance(indent + 1)
        if (pos < le) { const ch = src.charCodeAt(pos); if (ch === 32 || ch === 9) advance(1) }
        bqLine = true; bqIdx = d; fnTail = false
        continue
      }
      failKind = BQ
      break
    }
    if (k === LIST) continue
    if (k === ITEM && !c.sb && !c.fb) findNSL(c.cc)
    else findNS()
    if (k === ITEM) {
      fnTail = false
      if (blank) { c.fb = c.fb || c.sb; advance(indent < c.cc ? indent : c.cc); continue }
      if (c.fb || indent === 0) { c.fb = false; c.sb = false; failKind = ITEM; break }
      c.fb = false; c.sb = false
      if (indent >= c.cc) { advance(c.cc); continue }
      failKind = ITEM
      break
    }
    // FN
    if (blank) continue
    if (indent >= 4) { advance(4); fnLine = true; fnTail = true; continue }
    // micromark quirk: a nested footnote definition sees the previous footnote indent token as its own
    if (indent === 0 && fnTail) continue
    failKind = FN
    break
  }
  const allMatched = d >= sp
  closeAtPos = bqLine || fnLine ? pos : -1
  matchedPos = pos
  closeFn = fnLine
  bqLastLine = bqLine
  if (bqLine) { lineTok = true; lastBq = bqIdx }
  findNS()

  if (allMatched) {
    if (leaf === FCODE) { fcodeLine(); finishLine(); return }
    if (leaf === HTML) { if (htmlLine()) { finishLine(); return } }
    else if (leaf === ICODE) {
      if (icClosed) { closeLeaf(false); icClosed = false } // micromark: such code is one line, the next starts a new block
      else if (indent >= 4 || blank) {
        icodeLine(); finishLine(); return
      }
    } else if (leaf === TABLE) {
      if (tState === 1) { tState = 2; lineTok = true; lineCont = true; setE1(lineNo, ls, le); e2Line = lineNo; e2Ls = ls; e2Off = le; tNode.position.end = P(lineNo, ls, le); return }
    }
  }

  let ci = d - 1

  if (blank) {
    // blank line
    if (bqLine) { bqRun++; lastBqBlank = true }
    if (leaf !== NONE) closeLeaf(failKind === ITEM)
    if (bqLine && eolLen === 0 && pos === le && vleft === 0 && sp > ci + 1) {
      // last line without EOL: unmatched inner containers close right after the matched prefix
      closeAt(ci + 1, pos)
    } else if (bqLine && eolLen > 0 && sp > ci + 1) {
      const r = bqRun; bqRun = r - 1 // (one line ending less is inside the list when the blank line has its own EOL)
      closeContainers(ci + 1)
      bqRun = r
    } else closeContainers(ci + 1)
    pendingBlank = true; pbCi = ci; pbBq = stk[ci].kind === BQ
    // streaming: a complete blank line at the top level with nothing open is a point after which the past can no longer change
    if (streamOn && sp === 1 && leaf === NONE && eolLen > 0 && !noContainers && !(src.charCodeAt(le) === 13 && le + 1 >= len)) streamSafe = {off: le + eolLen, line: lineNo, n: root.children.length}
    finishLine()
    return
  }
  // a blank line inside a container that has been closed since (e.g. an empty `>` line) is not a blank
  // between the children of an outer item
  if (pendingBlank) { if (!(pbBq && pbCi > ci)) attribBlank(ci); pendingBlank = false }

  let paraTip = leaf === PARA
  const interrupt = allMatched && (paraTip || (leaf === ICODE && !icClosed))

  for (;;) {
    findNS()
    if (blank) {
      // rest of line blank after container start
      finishLine(); return
    }
    if (indent >= 4) {
      if (!paraTip) {
        const sp0 = sp
        ci = prepCI(ci, true, false)
        icClosed = sp < sp0
        startICode()
        finishLine(); return
      }
      break
    }
    const ch = src.charCodeAt(ns)
    if (ch === 62 && !noContainers) { // >
      ci = prepCI(ci, true, true, true)
      paraTip = false
      const node = {type: 'blockquote', children: [], position: {start: P(lineNo, ls, ns), end: undefined}}
      stk[ci].node.children.push(node)
      stk[sp++] = cont(BQ, node)
      ci = sp - 1
      advance(indent + 1)
      if (pos < le) { const c2 = src.charCodeAt(pos); if (c2 === 32 || c2 === 9) advance(1) }
      lineTok = true; lastBq = sp - 1
      continue
    }
    if (ch === 35) { // #
      let n = 1
      while (src.charCodeAt(ns + n) === 35) n++
      if (n <= 6) {
        const nx = ns + n
        const c2 = nx < le ? src.charCodeAt(nx) : 10
        if (nx >= le || c2 === 32 || c2 === 9) {
          ci = prepCI(ci, true, false)
          const hnode = {
            type: 'heading', depth: n, children: [],
            position: {start: P(lineNo, ls, ns), end: P(lineNo, ls, le)}
          }
          stk[ci].node.children.push(hnode)
          if (doInline) atxContent(hnode, ns + n)
          lineTok = true; lineCont = true
          finishLine(); return
        }
      }
      break
    }
    if (ch === 96 || ch === 126 || (ch === 36 && mathOn)) {
      if (startFence(ch, ci)) { finishLine(); return }
      break
    }
    if (ch === 60) {
      const k = htmlStart(paraTip && allMatched)
      if (k) {
        if (k === 7 && paraTip && !allMatched && eolLen > 0) {
          // micromark: an html (kind 7) start on a lazy line is allowed and stays in the open containers
          closeLeaf(false)
          ci = sp - 1
          startHtml(k)
          finishLine(); return
        }
        ci = prepCI(ci, true, false)
        startHtml(k)
        finishLine(); return
      }
      break
    }
    if (ch === 61 && paraTip && allMatched && isSetext(ch)) {
      if (paragraphHasContentAfterDefs()) {
        doSetext(1, ci)
        finishLine(); return
      }
      // only definitions so far: this line starts a new paragraph (micromark)
      closeLeaf(false); paraTip = false
      break
    }
    if (ch === 45 || ch === 42 || ch === 95) {
      const thematic = isThematic(ch)
      if (ch !== 95 && !thematic) {
        if (tryItem(ci, ch, interrupt)) { paraTip = false; ci = sp - 1; if (blank2) { finishLine(); return } continue }
      }
      if (ch === 45 && paraTip && allMatched && isSetext(45)) {
        if (paragraphHasContentAfterDefs()) {
          doSetext(2, ci)
          finishLine(); return
        }
        if (!thematic) { closeLeaf(false); paraTip = false; break }
      }
      if (thematic) {
        ci = prepCI(ci, true, false)
        stk[ci].node.children.push({type: 'thematicBreak', position: {start: P(lineNo, ls, ns), end: P(lineNo, ls, le)}})
        lineTok = true; lineCont = true
        finishLine(); return
      }
      break
    }
    if (ch === 43 || (ch >= 48 && ch <= 57)) {
      if (tryItem(ci, ch, interrupt)) { paraTip = false; ci = sp - 1; if (blank2) { finishLine(); return } continue }
      break
    }
    if (ch === 91 && src.charCodeAt(ns + 1) === 94) {
      if (tryFootnote(ci)) { paraTip = false; ci = sp - 1; continue }
      break
    }
    break
  }
  // paragraph / table / continuation
  // table head?
  if (leaf === TABLE && allMatched) {
    addTableRow()
    finishLine(); return
  }
  if (allMatched || !paraTip || true) {
    if (!paraTip || (allMatched && leaf === PARA) || !allMatched) {
      // table head detection
      if ((allMatched || !paraTip) && tryTableHead(ci)) { finishLine(); return }
      // micromark: a lazy line may be the head row of a table when the delimiter row line matches all containers
      if (!allMatched && paraTip && tryTableHead(sp - 1)) { finishLine(); return }
    }
  }
  if (paraTip) {
    // continuation (lazy or not)
    findNS()
    paraLine(false)
    finishLine(); return
  }
  // new paragraph
  ci = prepCI(ci, true, false)
  findNS()
  startPara()
  finishLine()
}

let blank2 = false

// ATX heading content range: port of micromark resolveHeadingAtx over the token list
let atxT = [], atxS = [], atxE = []
function atxContent(node, from) {
  // token types: 0 sequence, 1 whitespace, 2 text
  let nt = 0
  atxT[0] = 0; atxS[0] = ns; atxE[0] = from
  nt = 1
  let i = from
  while (i < le) {
    const c = src.charCodeAt(i)
    let ty
    const st = i
    if (c === 35) { while (i < le && src.charCodeAt(i) === 35) i++; ty = 0 }
    else if (c === 32 || c === 9) { while (i < le && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++; ty = 1 }
    else { while (i < le) { const d = src.charCodeAt(i); if (d === 35 || d === 32 || d === 9) break; i++ } ty = 2 }
    atxT[nt] = ty; atxS[nt] = st; atxE[nt] = i; nt++
  }
  // events: 0 enter heading, enter token j = 1 + 2j, exit token j = 2 + 2j, last = exit heading
  const evLen = 2 + 2 * nt
  const typeAt = idx => (idx <= 0 || idx >= evLen - 1) ? -1 : atxT[(idx - 1) >> 1]
  let contentEnd = evLen - 2
  let contentStart = 3
  if (typeAt(contentStart) === 1) contentStart += 2
  if (contentEnd - 2 > contentStart && typeAt(contentEnd) === 1) contentEnd -= 2
  if (typeAt(contentEnd) === 0 && (contentStart === contentEnd - 1 || (contentEnd - 4 > contentStart && typeAt(contentEnd - 2) === 1))) {
    contentEnd -= contentStart + 1 === contentEnd ? 2 : 4
  }
  if (contentEnd > contentStart) {
    const a = atxS[(contentStart - 1) >> 1], b = atxE[(contentEnd - 1) >> 1]
    pend.push(node, false, lineNo, ls, a, b, null, topNow())
  }
}

// micromark: when unmatched containers are closed by a NEW container starting on the same line and a
// blockquote prefix was consumed on that line, their exit sits right after that prefix (the `_container`
// fix cannot swap it before the previous line ending)
let closeAtPos = -1, closeFn = false, closeEol12 = false, matchedPos = 0
// last line on which an unclosed fence / html block included its EOL (its container exits sit after the next line's prefix)
let e12Line = -2
// micromark: a list that ends in 2+ blockquote-prefix-only lines is spread (those line endings stay inside it)
let bqRun = 0, lastBqBlank = false
let bqLastLine = false
let closeOver = null
function closeAt(to, at) {
  const a = e1Line, b = e1Ls, c = e1Off
  setE1(lineNo, ls, at)
  closeOver = () => P(lineNo, ls, at)
  closeContainers(to)
  closeOver = null
  setE1(a, b, c)
}
function closeForNew(to) {
  closeEol12 = false
  let at = closeAtPos
  if (at < 0 && e12Line === lineNo) { at = matchedPos; closeEol12 = true }
  if (at >= 0 && sp > to) {
    if (!closeEol12) bqRun++ // the exit sits after this line's prefix: one more trailing line ending counts
    closeAt(to, at)
    if (!closeEol12) bqRun--
  } else closeContainers(to)
}
function prepCI(ci, isBlock, eolInc, newContainer) {
  closeLeaf(eolInc)
  if (ci < sp - 1 && true) {
    // pop unmatched
    if (newContainer) closeForNew(ci + 1); else closeContainers(ci + 1)
  }
  if (stk[ci].kind === LIST) {
    if (newContainer) closeForNew(ci); else closeContainers(ci)
    ci--
    if (lateBlank) { lateBlank = false; attribBlank(ci) }
  }
  return ci
}

function finishLine() {
  if (!lastBqBlank) bqRun = 0
  if (lineTok) {
    setE1(lineNo, ls, le)
    if (lineCont) { e2Line = lineNo; e2Ls = ls; e2Off = le }
    else { ebLine = lineNo; ebLs = ls; ebOff = le; ebBi = lastBq }
  }
}
// end point for an item at stack index k closed by a following sibling item
function pickE2(k) {
  if (ebLine > (e2Off === e2Ls ? e2Line - 1 : e2Line) && ebBi > k) return P(ebLine, ebLs, ebOff)
  return P(e2Line, e2Ls, e2Off)
}

function startPara() {
  leaf = PARA
  pL = lineNo; pLs = ls; pOff = ns
  eL = lineNo; eLs = ls; eOff = le
  pCand = src.charCodeAt(ns) === 91
  pLines.length = 0; pPos.length = 0; pVl.length = 0
  pLines.push(lineNo, ls, ns, le); pPos.push(pos); pVl.push(vleft)
  lineTok = true; lineCont = true
}

function paraLine() {
  eL = lineNo; eLs = ls; eOff = le
  pLines.push(lineNo, ls, ns, le); pPos.push(pos); pVl.push(vleft)
  lineTok = true; lineCont = true
}

function startICode() {
  leaf = ICODE
  cL = lineNo; cLs = ls; cOff = pos
  advance(4)
  cVal = restOfLine()
  cLastL = lineNo; cLastLs = ls; cLastLe = le
  cEol = eolStr(le, eolLen)
  icPend = ''
  lineTok = true; lineCont = true
}

function icodeLine() {
  // continuing indented code (allMatched) with indent>=4 or blank
  if (blank) {
    const n = indent
    advance(n > 4 ? 4 : n)
    if (n >= 4) {
      cVal += icPend + cEol + restOfLine()
      icPend = ''
      cEol = eolStr(le, eolLen)
      cLastL = lineNo; cLastLs = ls; cLastLe = le
      lineTok = true; lineCont = true
      pendingBlank = false
      return
    }
    icPend += cEol + restOfLine()
    cEol = eolStr(le, eolLen)
    pendingBlank = true; pbBq = false
    return
  }
  advance(4)
  cVal += icPend + cEol + restOfLine()
  icPend = ''
  cEol = eolStr(le, eolLen)
  cLastL = lineNo; cLastLs = ls; cLastLe = le
  pendingBlank = false
  lineTok = true; lineCont = true
}

// ---- fenced code ----
function startFence(ch, ci) {
  let n = 1
  while (src.charCodeAt(ns + n) === ch) n++
  if (n < (ch === 36 ? 2 : 3)) return false
  const m = ns + n
  if (ch === 36) {
    // math flow: the rest of the line is the meta (raw, may not contain `$`)
    let k = m
    while (k < le && isWs(src.charCodeAt(k))) k++
    for (let q = k; q < le; q++) if (src.charCodeAt(q) === 36) return false
    let mm = k < le ? src.slice(k, le) : null
    if (mm !== null && (mm.indexOf('\\') !== -1 || mm.indexOf('&') !== -1)) mm = decodeString(mm)
    ci = prepCI(ci, true, false)
    leaf = FCODE
    cL = lineNo; cLs = ls; cOff = ns
    fch = ch; flen = n; findent = indent
    flang = null; fmeta = mm
    fEolCR = src.charCodeAt(le) === 13 && src.charCodeAt(le + 1) !== 10
    cVal = ''; cN = 0
    cLastL = lineNo; cLastLs = ls; cLastLe = le
    cRealL = lineNo; cRealLs = ls; cRealLe = le
    lineTok = true; lineCont = true
    return true
  }
  if (ch === 96) {
    for (let i = m; i < le; i++) if (src.charCodeAt(i) === 96) return false
  }
  // info
  let i = m
  while (i < le && isWs(src.charCodeAt(i))) i++
  let lang = null, meta = null
  if (i < le) {
    let j = i
    while (j < le && !isWs(src.charCodeAt(j))) j++
    lang = src.slice(i, j)
    let k = j
    while (k < le && isWs(src.charCodeAt(k))) k++
    if (k < le) {
      meta = src.slice(k, le)
    }
  }
  if (lang !== null && (lang.indexOf('\\') !== -1 || lang.indexOf('&') !== -1)) lang = decodeString(lang)
  if (meta !== null && (meta.indexOf('\\') !== -1 || meta.indexOf('&') !== -1)) meta = decodeString(meta)
  ci = prepCI(ci, true, false)
  leaf = FCODE
  cL = lineNo; cLs = ls; cOff = ns
  fch = ch; flen = n; findent = indent
  flang = lang; fmeta = meta
  fEolCR = src.charCodeAt(le) === 13 && src.charCodeAt(le + 1) !== 10
  cVal = ''; cN = 0
  cLastL = lineNo; cLastLs = ls; cLastLe = le
  cRealL = lineNo; cRealLs = ls; cRealLe = le
  lineTok = true; lineCont = true
  return true
}

function fcodeLine() {
  // allMatched, in fenced code
  if (indent <= 3 && !blank) {
    if (src.charCodeAt(ns) === fch) {
      let n = 1
      while (src.charCodeAt(ns + n) === fch) n++
      if (n >= flen) {
        let i = ns + n
        while (i < le && isWs(src.charCodeAt(i))) i++
        if (i >= le) {
          cLastL = lineNo; cLastLs = ls; cLastLe = le
          leaf = NONE
          finishFCode(true, false)
          lineTok = true; lineCont = true
          return
        }
      }
    }
  }
  const n = indent < findent ? indent : findent
  advance(n)
  const piece = restOfLine()
  if (cN === 0) cVal = piece
  else cVal += cEol + piece
  cN++
  cEol = eolStr(le, eolLen)
  cLastL = lineNo; cLastLs = ls; cLastLe = le
  // a last line (no EOL) that the open containers consume entirely is not part of the code
  cRealL = lineNo; cRealLs = ls; cRealLe = le
  if (blank && eolLen === 0 && piece === '' && n === 0 && sp > 1) cLastLe = ls
  if (!blank) lineTok = true; lineCont = true
}

// ---- html ----
const RAW = ['script', 'pre', 'style', 'textarea']
function lc(c) { return c | 32 }
function isAlpha(c) { c |= 32; return c >= 97 && c <= 122 }
function isAlnum(c) { return isAlpha(c) || (c >= 48 && c <= 57) }

function htmlStart(paraTip) {
  const c1 = src.charCodeAt(ns + 1)
  if (c1 === 33) {
    const c2 = src.charCodeAt(ns + 2)
    if (c2 === 45) return src.charCodeAt(ns + 3) === 45 ? 2 : 0
    if (c2 === 91) return src.startsWith('CDATA[', ns + 3) ? 5 : 0
    if (isAlpha(c2)) return 4
    return 0
  }
  if (c1 === 63) return 3
  let i = ns + 1
  let closing = false
  if (c1 === 47) { closing = true; i++ }
  const c = src.charCodeAt(i)
  if (!isAlpha(c)) return 0
  const s = i
  while (i < le && (isAlnum(src.charCodeAt(i)) || src.charCodeAt(i) === 45)) i++
  const name = src.slice(s, i).toLowerCase()
  const after = i < le ? src.charCodeAt(i) : 10
  const terminal = i >= le || after === 62 || after === 47 || after === 32 || after === 9
  if (terminal) {
    if (after !== 47 && !closing && RAW.indexOf(name) !== -1) return 1
    if (BLOCK_NAMES.has(name)) {
      if (after === 47) return src.charCodeAt(i + 1) === 62 ? 6 : 0
      return 6
    }
  }
  if (paraTip) return 0
  if (!terminal) return 0
  // kind 7: complete tag
  const e = completeTag(i, closing)
  if (e < 0) return 0
  let j = e
  while (j < le && isWs(src.charCodeAt(j))) j++
  return j >= le ? 7 : 0
}

// i: index after tag name; returns index after '>' or -1
function completeTag(i, closing) {
  if (closing) {
    while (i < le && isWs(src.charCodeAt(i))) i++
    return src.charCodeAt(i) === 62 && i < le ? i + 1 : -1
  }
  // port of micromark html-flow complete* states (kind 7); the end of the line behaves like an EOL code
  let st = 0, marker = 0
  for (;;) {
    const c = i < le ? src.charCodeAt(i) : -1
    switch (st) {
      case 0: // attribute name before
        if (c === 47) { i++; st = 7; continue }
        if (c === 58 || c === 95 || isAlpha(c)) { i++; st = 1; continue }
        if (c === 32 || c === 9) { i++; continue }
        st = 7
        continue
      case 1: // attribute name
        if (c === 45 || c === 46 || c === 58 || c === 95 || isAlnum(c)) { i++; continue }
        st = 2
        continue
      case 2: // attribute name after
        if (c === 61) { i++; st = 3; continue }
        if (c === 32 || c === 9) { i++; continue }
        st = 0
        continue
      case 3: // attribute value before
        if (c === -1 || c === 60 || c === 61 || c === 62 || c === 96) return -1
        if (c === 34 || c === 39) { i++; marker = c; st = 4; continue }
        if (c === 32 || c === 9) { i++; continue }
        st = 5
        continue
      case 4: // quoted
        if (c === marker) { i++; st = 6; continue }
        if (c === -1) return -1
        i++
        continue
      case 5: // unquoted
        if (c === -1 || c === 34 || c === 39 || c === 47 || c === 60 || c === 61 || c === 62 || c === 96 || c === 32 || c === 9) { st = 2; continue }
        i++
        continue
      case 6: // quoted after
        if (c === 47 || c === 62 || c === 32 || c === 9) { st = 0; continue }
        return -1
      case 7: // end
        return c === 62 ? i + 1 : -1
    }
  }
}

// index of str within the current line [from, le), else -1 (never scans past the line)
function idxLine(str, from) {
  const c0 = str.charCodeAt(0), n = str.length
  const end = le - n
  for (let i = from; i <= end; i++) {
    if (src.charCodeAt(i) === c0 && (n === 1 || src.startsWith(str, i))) return i
  }
  return -1
}

function htmlEnds(k, from) {
  // does the line (from index) contain the end condition for kind k
  switch (k) {
    case 1: {
      let i = from
      for (;;) {
        i = idxLine('</', i)
        if (i === -1) return false
        const s = src.slice(i + 2, i + 12).toLowerCase()
        if (s.startsWith('script>') || s.startsWith('style>') || s.startsWith('pre>') || s.startsWith('textarea>')) return true
        i += 2
      }
    }
    case 2: return idxLine('-->', from) !== -1
    case 3: return idxLine('?>', from) !== -1
    case 4: return idxLine('>', from) !== -1
    case 5: {
      // micromark's state machine: `]]]>` does not end the block, `]]]]>` does
      let st = 0
      for (let i = from; i < le; i++) {
        const c = src.charCodeAt(i)
        if (st === 0) st = c === 93 ? 1 : 0
        else if (st === 1) st = c === 93 ? 2 : 0
        else { if (c === 62) return true; st = c === 93 ? 1 : 0 }
      }
      return false
    }
  }
  return false
}

function startHtml(k) {
  cRealL = lineNo; cRealLs = ls; cRealLe = le
  leaf = HTML
  hkind = k
  cL = lineNo; cLs = ls; cOff = pos
  cVal = restOfLine()
  cLastL = lineNo; cLastLs = ls; cLastLe = le
  lineTok = true; lineCont = true
  if (k <= 5) {
    const from = k === 2 ? ns + 2 : k === 3 ? ns + 1 : k === 5 ? ns + 9 : ns + 1
    if (htmlEnds(k, from)) { leaf = NONE; finishHtml(false) }
  }
}

// returns true if consumed
function htmlLine() {
  if (hkind >= 6) {
    if (blank) { return false } // caller falls through; need to close
    advance(indent < 0 ? 0 : 0)
    cVal += eolStr(cLastLe, 0) + ''
  }
  // append line
  const prevEol = cEolHtml()
  const rest = restOfLine()
  cVal += prevEol + rest
  cLastL = lineNo; cLastLs = ls; cLastLe = le
  cRealL = lineNo; cRealLs = ls; cRealLe = le
  if (hkind <= 5 && blank && eolLen === 0 && rest === '' && sp > 1) cLastLe = ls
  lineTok = true; lineCont = true
  if (hkind <= 5 && htmlEnds(hkind, pos)) { leaf = NONE; finishHtml(false) }
  return true
}
function cEolHtml() {
  // eol of previous line: src at cLastLe
  const c = src.charCodeAt(cLastLe)
  if (c === 13) return src.charCodeAt(cLastLe + 1) === 10 ? '\r\n' : '\r'
  return '\n'
}

// ---- thematic / setext ----
function isThematic(ch) {
  let n = 0
  for (let i = ns; i < le; i++) {
    const c = src.charCodeAt(i)
    if (c === ch) n++
    else if (c !== 32 && c !== 9) return false
  }
  return n >= 3
}

function isSetext(ch) {
  let i = ns
  while (i < le && src.charCodeAt(i) === ch) i++
  if (i === ns) return false
  while (i < le && isWs(src.charCodeAt(i))) i++
  return i >= le
}

function doSetext(depth, ci) {
  // finalize paragraph into heading
  leaf = NONE
  const end = P(lineNo, ls, le)
  finishParagraph(-1, {depth, end})
  lineTok = true; lineCont = true
}

// ---- lists ----
let quirkItem = null
function tryItem(ci, ch, interrupt) {
  if (noContainers) return false
  blank2 = false
  let mlen = 1
  let ordered = false
  let delim = ch
  let value = 0
  if (ch >= 48 && ch <= 57) {
    ordered = true
    let n = 0
    let i = ns
    while (i < le) {
      const c = src.charCodeAt(i)
      if (c >= 48 && c <= 57) { n++; i++ } else break
    }
    if (n > 9) return false
    delim = src.charCodeAt(i)
    if (delim !== 46 && delim !== 41) return false
    if (interrupt && !(n === 1 && ch === 49)) return false
    mlen = n + 1
    value = parseInt(src.slice(ns, ns + n), 10)
  }
  const m = ns + mlen
  // after marker
  let restBlank = true
  let wsCols = 0
  let j = m
  let cc = col + indent + mlen // virtual column after marker, relative to line start
  // compute whitespace columns following marker
  {
    let cur = cc
    while (j < le) {
      const c = src.charCodeAt(j)
      if (c === 32) { cur++; j++ } else if (c === 9) { cur += 4 - (cur & 3); j++ } else break
    }
    wsCols = cur - cc
    restBlank = j >= le
  }
  if (restBlank) {
    if (interrupt) return false
  } else if (wsCols === 0) return false
  // sibling / new list
  const top = stk[ci]
  let compatible = false
  if (top.kind === LIST) {
    compatible = top.ord === ordered && top.mk === delim
  }
  // commit
  const quirk = leaf === FCODE || (leaf === HTML && hkind <= 5)
  closeLeaf(failKind === ITEM || true)
  if (top.kind === LIST && compatible) {
    // sibling
    const itemNode = stk[ci + 1].node
    const pe = pickE2(ci + 1)
    if (e12Line === lineNo) closeForNew(ci + 1); else closeContainers(ci + 1)
    itemNode.position.end = pe
    const fnQuirk = closeFn && closeAtPos >= 0 // footnote indent: the item ends at the end of the next item's prefix
    quirkItem = quirk || fnQuirk ? itemNode : null
    lateBlank = false
    if (!quirk && !fnQuirk && pe.line + 1 < lineNo) top.node.spread = true
    else if (fnQuirk && !quirk && pe.line + 1 < lineNo) itemNode.spread = true
  } else {
    closeForNew(ci + 1)
    if (top.kind === LIST) { closeForNew(ci); ci--; if (lateBlank) { lateBlank = false; attribBlank(ci) } }
    const lnode = {type: 'list', ordered, start: ordered ? value : null, spread: false, children: [], position: {start: P(lineNo, ls, ns), end: undefined}}
    stk[ci].node.children.push(lnode)
    const lc = cont(LIST, lnode)
    lc.ord = ordered; lc.mk = delim
    stk[sp++] = lc
    ci = sp - 1
  }
  const lcont = stk[ci]
  const item = {type: 'listItem', spread: false, checked: null, children: [], position: {start: P(lineNo, ls, ns), end: undefined}}
  lcont.node.children.push(item)
  const ic = cont(ITEM, item)
  const initialSize = indent
  stk[sp++] = ic
  advance(indent + mlen)
  lineTok = true; lineCont = true
  if (restBlank) {
    if (quirkItem) { quirkItem.position.end = P(lineNo, ls, pos); quirkItem = null }
    if (j === m && eolLen > 0) emptyItemLine = lineNo
    ic.sb = true
    ic.cc = initialSize + mlen + 1
    blank2 = true
    return true
  }
  if (wsCols <= 4 && true) {
    advance(wsCols)
    ic.cc = initialSize + mlen + wsCols
  } else {
    advance(1)
    ic.cc = initialSize + mlen + 1
  }
  if (quirkItem) { quirkItem.position.end = P(lineNo, ls, pos); quirkItem = null }
  return true
}

// ---- footnote definitions ----
function tryFootnote(ci) {
  if (noContainers) return false
  let i = ns + 2
  let size = 0
  let data = false
  for (;;) {
    if (i >= le) return false
    const c = src.charCodeAt(i)
    if (size > 999 || (c === 93 && !data) || c === 91 || c === 32 || c === 9) return false
    if (c === 93) break
    data = true
    size++
    i++
    if (c === 92) {
      const d = src.charCodeAt(i)
      if (d === 91 || d === 92 || d === 93) { i++; size++ }
    }
  }
  if (src.charCodeAt(i + 1) !== 58) return false
  const raw = src.slice(ns + 2, i)
  fnIds.add(normalizeIdentifier(raw))
  ci = prepCI(ci, true, true, true)
  const label = raw.indexOf('\\') === -1 && raw.indexOf('&') === -1 ? raw : decodeString(raw)
  const node = {
    type: 'footnoteDefinition', identifier: normalizeIdentifier(raw).toLowerCase(), label, children: [],
    position: {start: P(lineNo, ls, ns), end: undefined}
  }
  stk[ci].node.children.push(node)
  if (streamOn) fnLog.push(normalizeIdentifier(raw), topNow())
  stk[sp++] = cont(FN, node)
  advance(indent + (i + 2 - ns))
  // whitespace
  let w = 0
  {
    let cur = col + vleft
    let j = pos
    while (j < le) {
      const c = src.charCodeAt(j)
      if (c === 32) { cur++; j++ } else if (c === 9) { cur += 4 - (cur & 3); j++ } else break
    }
    w = cur - (col + vleft)
  }
  advance(w)
  lineTok = true; lineCont = true
  return true
}

// ---- tables ----
function tryTableHead(ci) {
  // head row = current line from ns. next line must be delimiter row
  if (indent >= 4) return false // a paragraph continuation, not a table head
  if (le + eolLen >= len || eolLen === 0) return false
  // quick pre-check of next raw line
  const nls = le + eolLen
  {
    let i = nls
    let dash = false
    for (;;) {
      if (i >= len) break
      const c = src.charCodeAt(i)
      if (c === 10 || c === 13) break
      if (c === 45) dash = true
      else if (c !== 124 && c !== 58 && c !== 32 && c !== 9 && c !== 62) return false
      i++
    }
    if (!dash) return false
  }
  const size = headRowSize(ns, le)
  if (size === 0) return false
  // peek delimiter row
  const al = peekDelimiter(size, ci)
  if (!al) return false
  // commit table
  ci = prepCI(ci, true, false)
  const node = {type: 'table', align: al, children: [], position: {start: P(lineNo, ls, ns), end: undefined}}
  stk[ci].node.children.push(node)
  tNode = node
  leaf = TABLE
  tState = 1
  addRow(ns, le)
  lineTok = true; lineCont = true
  return true
}

function headRowSize(from, to) {
  let size = 0, sizeB = 0, seen = false
  let i = from
  if (src.charCodeAt(i) !== 124) { seen = true; sizeB += 1 }
  for (;;) {
    if (i >= to) return sizeB > 1 ? size : 0
    const c = src.charCodeAt(i)
    if (c === 32 || c === 9) { i++; continue }
    sizeB += 1
    if (seen) { seen = false; size += 1 }
    if (c === 124) { seen = true; i++; continue }
    // data
    for (;;) {
      if (i >= to) break
      const d = src.charCodeAt(i)
      if (d === 124 || d === 32 || d === 9) break
      i++
      if (d === 92) {
        const e = src.charCodeAt(i)
        if ((e === 92 || e === 124) && i < to) i++
      }
    }
  }
}

function peekDelimiter(size, ci) {
  // save state
  const s_ls = ls, s_le = le, s_eol = eolLen, s_line = lineNo, s_pos = pos, s_col = col, s_vleft = vleft
  const s_ns = ns, s_indent = indent, s_blank = blank
  let result = null
  ls = le + eolLen
  if (!hasCR) {
    le = src.indexOf('\n', ls)
    if (le === -1) { le = len; eolLen = 0 } else eolLen = 1
  } else {
    let i = ls
    for (;;) {
      if (i >= len) { le = len; eolLen = 0; break }
      const c = src.charCodeAt(i)
      if (c === 10) { le = i; eolLen = 1; break }
      if (c === 13) { le = i; eolLen = src.charCodeAt(i + 1) === 10 ? 2 : 1; break }
      i++
    }
  }
  lineNo++
  pos = ls; col = 0; vleft = 0
  let ok = true
  const cnt = stk[ci].kind === LIST ? ci : ci + 1
  for (let d = 1; d < cnt; d++) {
    const c = stk[d]
    const k = c.kind
    if (k === BQ) {
      findNS()
      if (indent <= 3 && ns < le && src.charCodeAt(ns) === 62) {
        advance(indent + 1)
        if (pos < le) { const ch = src.charCodeAt(pos); if (ch === 32 || ch === 9) advance(1) }
        continue
      }
      ok = false; break
    }
    if (k === LIST) continue
    findNS()
    if (k === ITEM) {
      if (blank || c.fb || c.sb || indent === 0 || indent < c.cc) { ok = false; break }
      advance(c.cc)
      continue
    }
    if (blank || indent < 4) { ok = false; break }
    advance(4)
  }
  if (ok) {
    findNS()
    if (!blank) {
      // not a new container
      const ch = src.charCodeAt(ns)
      let container = false
      if (indent <= 3 && !noContainers) {
        if (ch === 62) container = true
        else if ((ch === 45 || ch === 43 || ch === 42) && (ns + 1 >= le || isWs(src.charCodeAt(ns + 1)))) container = true
        else if (ch >= 48 && ch <= 57) container = true // approximate
        else if (ch === 91 && src.charCodeAt(ns + 1) === 94) container = true
      }
      if (!container || (ch >= 48 && ch <= 57 && !digitItem())) {
        result = delimRow(ns, le, size, indent)
      }
    }
  }
  ls = s_ls; le = s_le; eolLen = s_eol; lineNo = s_line; pos = s_pos; col = s_col; vleft = s_vleft
  ns = s_ns; indent = s_indent; blank = s_blank
  return result
}

function digitItem() {
  let i = ns, n = 0
  while (i < le) { const c = src.charCodeAt(i); if (c >= 48 && c <= 57) { n++; i++ } else break }
  if (n === 0 || n > 9) return false
  const d = src.charCodeAt(i)
  return d === 46 || d === 41
}

// returns align array or null
function delimRow(from, to, size, ind) {
  let i = from
  let sizeB = 0
  let seen = false
  const aligns = []
  if (ind > 3) return null
  const c0 = src.charCodeAt(i)
  if (c0 === 124) { seen = true; i++ }
  else if (c0 !== 45 && c0 !== 58) return null
  for (;;) {
    // cell: ws, :?-+:? ws
    while (i < to && isWs(src.charCodeAt(i))) i++
    let c = src.charCodeAt(i)
    if (i >= to) break
    let left = false, right = false
    if (c === 58) { sizeB++; seen = true; left = true; i++; c = src.charCodeAt(i); if (c !== 45) return null }
    else if (c === 45) { sizeB++ }
    else return null
    while (src.charCodeAt(i) === 45 && i < to) i++
    if (src.charCodeAt(i) === 58 && i < to) { seen = true; right = true; i++ }
    while (i < to && isWs(src.charCodeAt(i))) i++
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null)
    if (i >= to) break
    if (src.charCodeAt(i) === 124) {
      seen = true; i++
      continue
    }
    return null
  }
  if (!seen || size !== sizeB) return null
  return aligns
}

function addTableRow() {
  // body row: line from ns
  addRow(ns, le)
  lineTok = true; lineCont = true
}

function addRow(from, to) {
  // build row with cells per micromark resolveTable semantics
  const row = {type: 'tableRow', children: [], position: {start: P(lineNo, ls, from), end: P(lineNo, ls, to)}}
  // tokenise: dividers and data
  // events list: [idx] -> {kind: 'd' divider | 'data', s, e}
  const ev = [null]
  let i = from
  while (i < to) {
    const c = src.charCodeAt(i)
    if (c === 124) { ev.push({k: 1, s: i, e: i + 1}); i++; continue }
    if (c === 32 || c === 9) { i++; continue }
    const s = i
    for (;;) {
      if (i >= to) break
      const d = src.charCodeAt(i)
      if (d === 124 || d === 32 || d === 9) break
      i++
      if (d === 92) { const e = src.charCodeAt(i); if ((e === 92 || e === 124) && i < to) i++ }
    }
    ev.push({k: 2, s, e: i})
  }
  // cells
  let inFirst = true
  let lastCell = [0, 0, 0, 0]
  let cell = [0, 1, 0, 0] // index+1 of row enter => first event index 1 (or row-exit)
  let cur = undefined
  const cells = []
  const pointOf = (idx, rowEnd) => idx === -1 ? to : ev[idx].s // starts
  // flush
  function flush(range, rowEnd) {
    // range[0]: index whose start point closes previous cell
    if (range[0] !== 0 && cur) cur.e = ev[range[0]] ? ev[range[0]].s : to
    const startP = range[1] <= ev.length - 1 ? ev[range[1]].s : from
    const c = {s: range[1] === 1 ? from : startP, e: startP}
    // first event after row enter starts at row start
    if (range[1] === 1) c.s = from
    if (range[2] !== 0) { c.ds = ev[range[2]].s; c.de = ev[range[3]].e }
    cells.push(c)
    cur = c
    if (rowEnd) { c.e = to; cur = undefined }
  }
  const n = ev.length - 1
  for (let idx = 1; idx <= n + 0; idx++) {
    const e = ev[idx]
    if (e.k === 2) {
      inFirst = false
      if (cell[2] === 0) {
        if (lastCell[1] !== 0) {
          cell[0] = cell[1]
          flush(lastCell, false)
          lastCell = [0, 0, 0, 0]
        }
        cell[2] = idx
      }
      cell[3] = idx
    } else {
      if (inFirst) inFirst = false
      else {
        if (lastCell[1] !== 0) {
          cell[0] = cell[1]
          flush(lastCell, false)
        }
        lastCell = cell
        cell = [lastCell[1], idx, 0, 0]
      }
    }
  }
  // row end
  if (lastCell[1] !== 0) {
    cell[0] = cell[1]
    flush(lastCell, true)
  } else if (cell[1] !== 0 && n >= 1) {
    flush(cell, true)
  }
  for (const c of cells) {
    const cn = {type: 'tableCell', children: [], position: {start: P(lineNo, ls, c.s), end: P(lineNo, ls, c.e)}}
    row.children.push(cn)
    if (doInline && c.ds !== undefined) pend.push(cn, 'table', lineNo, ls, c.ds, c.de, null, topNow())
  }
  tNode.children.push(row)
  tNode.position.end = P(lineNo, ls, to)
}

// streaming entry point: parse a tail of the document (starting at a top-level safe point) and report what the
// stream parser needs: the last safe point, definition / footnote ids by top-level index, root.checked log and the
// phrasing nodes whose inline content depends on definition ids
export function parseStream(source, opts) {
  const root = parse(source, {...opts, stream: true, tail: true})
  return {root, safe: streamSafe, defLog: defLog.slice(), fnLog: fnLog.slice(), rcLog: rcLog.slice(), entries: streamEntries, defIds, fnIds}
}
