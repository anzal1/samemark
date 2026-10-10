// Incremental parser for streaming text (LLM chat UIs).
//
//   const s = createStreamParser({frontmatter, math})
//   const tree = s.push(chunk)        // === parse(everything pushed so far, options), positions included
//   const final = s.end()
//   s.reset()
//
// How it stays exact and cheap:
// * The block parser is deterministic left to right. A COMPLETE blank line at the top level with nothing open
//   (no container, no open leaf: fence, html, indented code, paragraph, table) is a safe point: the text before
//   it can never change again (setext underlines, table delimiter rows, lazy continuation, list continuation all need
//   adjacency). Everything before the last safe point is finished; every push re-parses only the text after it.
// * Finished top-level nodes are reused as the same objects. They are only replaced when a later definition or
//   footnote definition changes how a bracket in them resolves (a finished paragraph with `[x]` turns into a
//   linkReference): the inline parser records which definition ids a paragraph looked up, and the node is rebuilt
//   (copy on write along its path, so changed blocks get new identities) when one of those ids appears or vanishes.
// * Positions: the tail is parsed on its own and its positions are shifted by the offset / line of the safe point.
import {parseStream, normalizeMatters} from './block.js'
import {inlineSingle, inlineMulti, setSource, setDefinitions, setMath, setTrackDefs, takeNeeds} from './inline.js'

function shift(nodes, bl, bo) {
  const st = nodes.slice()
  while (st.length) {
    const nd = st.pop()
    const p = nd.position
    if (p !== undefined) {
      p.start.line += bl; p.start.offset += bo
      p.end.line += bl; p.end.offset += bo
    }
    const ch = nd.children
    if (ch !== undefined) for (let i = 0; i < ch.length; i++) st.push(ch[i])
  }
}

function findPath(top, target) {
  if (top === target) return []
  const st = [[top, []]]
  while (st.length) {
    const [nd, path] = st.pop()
    const ch = nd.children
    if (ch === undefined) continue
    for (let i = 0; i < ch.length; i++) {
      if (ch[i] === target) return path.concat(i)
      st.push([ch[i], path.concat(i)])
    }
  }
  return null
}

function composite(a, b) {
  return {has: id => a.has(id) || b.has(id), get size() { return a.size + b.size }}
}

export function createStreamParser(options) {
  const base = {}
  let mathOpt = null
  if (options && options.frontmatter !== undefined && options.frontmatter !== false) {
    const f = options.frontmatter
    base.frontmatter = Array.isArray(f) && f.length && f[0] && typeof f[0] === 'object' && 'open' in f[0] ? f : normalizeMatters(f === true ? undefined : f)
  }
  if (options && options.math) { base.math = options.math === true ? {single: true} : options.math; mathOpt = base.math }

  let done, tail, BL, BO, accLen, finalDefs, finalFns, finalChecked, negIndex, posIndex, prevTailD, prevTailF
  function reset() {
    done = []; tail = ''; BL = 0; BO = 0; accLen = 0
    finalDefs = new Set(); finalFns = new Set(); finalChecked = undefined
    negIndex = new Map(); posIndex = new Map(); prevTailD = new Set(); prevTailF = new Set()
  }
  const idx = (m, id, e) => { let s = m.get(id); if (s === undefined) { s = new Set(); m.set(id, s) } s.add(e) }
  const unidx = (m, id, e) => { const s = m.get(id); if (s !== undefined) { s.delete(e); if (s.size === 0) m.delete(id) } }
  function index(e) { for (const id of e.neg) idx(negIndex, id, e); for (const id of e.pos) idx(posIndex, id, e) }
  function unindex(e) { for (const id of e.neg) unidx(negIndex, id, e); for (const id of e.pos) unidx(posIndex, id, e) }
  reset()

  const has = (id, eD, eF) => id.charCodeAt(0) === 94 ? eF.has(id.slice(1)) : eD.has(id)

  function rerun(e, eD, eF) {
    setSource(e.src)
    setDefinitions(eD, eF)
    setMath(Boolean(mathOpt), !mathOpt || mathOpt.single !== false)
    setTrackDefs(true)
    const tmp = {type: 'phrasing', position: {start: Object.assign({}, e.startLocal), end: null}}
    if (e.ml !== null) inlineMulti(tmp, e.ml, e.task)
    else inlineSingle(tmp, e.line, e.ls, e.cs, e.ce, e.table, e.task)
    const nd = takeNeeds()
    setTrackDefs(false)
    unindex(e)
    e.neg = nd ? nd.neg : []; e.pos = nd ? nd.pos : []
    index(e)
    const children = tmp.children
    shift(children, e.BL, e.BO)
    // copy on write along the path so the changed top-level block gets a new identity
    const top = done[e.top]
    const nt = Object.assign({}, top)
    if (top.children) nt.children = top.children.slice()
    let cur = nt
    for (let i = 0; i < e.path.length; i++) {
      const child = cur.children[e.path[i]]
      const nc = Object.assign({}, child)
      if (child.children) nc.children = child.children.slice()
      cur.children[e.path[i]] = nc
      cur = nc
    }
    cur.children = children
    const s = tmp.position.start
    cur.position = {start: {line: s.line + e.BL, column: s.column, offset: s.offset + e.BO}, end: cur.position.end}
    done[e.top] = nt
  }

  function refresh() {
    const opts = {tail: true, defs: finalDefs, fnDefs: finalFns}
    if (base.math) opts.math = base.math
    if (base.frontmatter && BO === 0 && done.length === 0) opts.frontmatter = base.frontmatter
    const res = parseStream(tail, opts)
    const troot = res.root
    shift(troot.children, BL, BO)
    shift([{position: troot.position}], BL, BO)

    // finished nodes whose bracket resolution depends on definitions that appeared / vanished since the last push
    // (membership only changes through the ids of the unfinished tail: finished definitions never vanish)
    if (negIndex.size || posIndex.size) {
      const eD = composite(finalDefs, res.defIds), eF = composite(finalFns, res.fnIds)
      const todo = new Set()
      const diff = (cur, prev, fin, pfx) => {
        for (const id of cur) if (!prev.has(id) && !fin.has(id)) { const s = negIndex.get(pfx + id); if (s) for (const e of s) todo.add(e) }
        for (const id of prev) if (!cur.has(id) && !fin.has(id)) { const s = posIndex.get(pfx + id); if (s) for (const e of s) todo.add(e) }
      }
      diff(res.defIds, prevTailD, finalDefs, '')
      diff(res.fnIds, prevTailF, finalFns, '^')
      for (const e of todo) rerun(e, eD, eF)
    }
    prevTailD = res.defIds; prevTailF = res.fnIds

    const out = {
      type: 'root',
      children: done.length ? done.concat(troot.children) : troot.children,
      position: {start: {line: 1, column: 1, offset: 0}, end: troot.position.end}
    }
    const checked = troot.checked !== undefined ? troot.checked : finalChecked
    if (checked !== undefined) out.checked = checked

    // everything before the last safe point is final from now on
    const safe = res.safe
    if (safe !== null) {
      const k = safe.n
      for (let i = 0; i < res.defLog.length; i += 2) if (res.defLog[i + 1] < k) finalDefs.add(res.defLog[i])
      for (let i = 0; i < res.fnLog.length; i += 2) if (res.fnLog[i + 1] < k) finalFns.add(res.fnLog[i])
      for (let i = 0; i < res.rcLog.length; i += 2) if (res.rcLog[i] < k) finalChecked = res.rcLog[i + 1]
      for (const e of res.entries) {
        if (e.top >= k) continue
        const path = findPath(troot.children[e.top], e.node)
        if (path === null) continue
        index({
          top: done.length + e.top, path, task: e.task, table: e.table, line: e.line, ls: e.ls, cs: e.cs, ce: e.ce, ml: e.ml,
          startLocal: e.startLocal, neg: e.neg, pos: e.pos, src: tail, BL, BO
        })
      }
      for (let i = 0; i < k; i++) done.push(troot.children[i])
      tail = tail.slice(safe.off)
      BL += safe.line
      BO += safe.off
    }
    return out
  }

  return {
    push(chunk) {
      chunk = String(chunk)
      if (accLen === 0 && chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1)
      if (chunk.indexOf('\0') !== -1) chunk = chunk.replaceAll('\0', '�')
      accLen += chunk.length
      tail += chunk
      return refresh()
    },
    end() { return refresh() },
    reset
  }
}
