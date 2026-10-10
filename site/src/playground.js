// Playground: samemark/core (stock GFM, browser build) against mdast-util-from-markdown + GFM, both in this tab.
import {parse} from '../../core.js'
import {fromMarkdown} from 'mdast-util-from-markdown'
import {gfm} from 'micromark-extension-gfm'
import {gfmFromMarkdown} from 'mdast-util-gfm'
import sample from './sample.md'
import {fmtMs} from './format.js'

const reference = text => fromMarkdown(text, {extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()]})

// first difference between two json-ish values (same rule as firstDiff in bench/common.mjs)
function firstDiff(a, b, path = '') {
  if (a === b) return null
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) return {path, a, b}
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) return {path: path + '[' + i + ']', a: a[i], b: b[i]}
      const d = firstDiff(a[i], b[i], path + '[' + i + ']')
      if (d) return d
    }
    return null
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[k], b[k], path + '.' + k)
    if (d) return d
  }
  return null
}
const count = n => 1 + (n.children ? n.children.reduce((s, c) => s + count(c), 0) : 0)
const strip = (k, v) => (k === 'position' ? undefined : v)

// time of one parse: warm-up call, then batches of repeated parses (a single parse of a short text is below the timer
// resolution of browsers), median of 5 batches divided by the batch size
function time(fn, text) {
  let t0 = performance.now()
  fn(text)
  const first = performance.now() - t0
  if (first > 20) return {ms: first, reps: 1}
  const batch = n => { const t = performance.now(); for (let i = 0; i < n; i++) fn(text); return performance.now() - t }
  let reps = 1, dt = batch(reps)
  while (dt < 5 && reps < 8192) { reps *= 2; dt = batch(reps) }
  const samples = [dt / reps]
  for (let i = 0; i < 4; i++) samples.push(batch(reps) / reps)
  samples.sort((x, y) => x - y)
  return {ms: samples[2], reps}
}

const show = (el, pre, mark, post) => {
  el.textContent = ''
  el.append(pre)
  if (mark !== null) { const m = document.createElement('mark'); m.textContent = mark; el.append(m, post) }
}

export function initPlayground() {
  const $ = id => document.getElementById(id)
  const src = $('src'), pos = $('pos'), verdict = $('verdict')
  src.value = sample.replace(/\n$/, '')
  let timer = 0

  function update() {
    const text = src.value
    let a, b, errA = null
    try { a = parse(text) } catch (e) { errA = e }
    b = reference(text)
    const showPos = pos.checked
    const jb = JSON.parse(JSON.stringify(b))
    let diff = null, ja = null
    if (errA) diff = {path: '(samemark threw)', a: String(errA.message), b: 'a tree'}
    else { ja = JSON.parse(JSON.stringify(a)); diff = firstDiff(ja, jb) }
    const fa = ja ? JSON.stringify(ja, showPos ? null : strip, 1) : String(errA)
    const fb = JSON.stringify(jb, showPos ? null : strip, 1)
    let hit = -1
    if (diff) {
      const la = fa.split('\n'), lb = fb.split('\n')
      for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) { hit = i; break }
    }
    const paint = (el, full) => {
      if (hit < 0) return show(el, full, null)
      const lines = full.split('\n')
      const pre = lines.slice(0, hit).join('\n') + (hit ? '\n' : '')
      show(el, pre, lines[hit] ?? '', lines.length > hit + 1 ? '\n' + lines.slice(hit + 1).join('\n') : '')
    }
    paint($('tree-fast'), fa); paint($('tree-ref'), fb)
    const tf = errA ? null : time(parse, text), tr = time(reference, text)
    $('t-fast').textContent = tf ? fmtMs(tf.ms) : 'threw'
    $('t-ref').textContent = fmtMs(tr.ms)
    const speed = tf && tf.ms > 0 ? ` samemark parsed it ${(tr.ms / tf.ms).toFixed(1)}x faster here (${fmtMs(tf.ms)} against ${fmtMs(tr.ms)}, median of 5 batches).` : ''
    if (!diff) {
      verdict.className = 'badge pass'
      verdict.textContent = `First difference: none. The trees are equal, positions included (${count(jb)} nodes).` + speed
    } else {
      verdict.className = 'badge fail'
      verdict.textContent = `First difference at ${diff.path || '(root)'}: samemark ${JSON.stringify(diff.a)?.slice(0, 80)}, reference ${JSON.stringify(diff.b)?.slice(0, 80)}. Please report this input.` + (hit >= 0 ? ' The line is highlighted.' : ' It is in a position field: tick "Show position fields".')
    }
    window.__samemarkPlayground = {equal: !diff, nodes: count(jb), diff}
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(update, 120) }
  src.addEventListener('input', later)
  pos.addEventListener('change', update)
  update()
}
