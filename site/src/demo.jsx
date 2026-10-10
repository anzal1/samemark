// Streaming demo. Left: react-markdown re-rendering the whole message on every update (what most chat UIs do).
// Right: samemark/stream with one memoised React block per finished top-level node (examples/react-chat).
// Same structure as the Chromium benchmark in bench/perf/reactmd-browser.mjs: every update is committed synchronously
// with flushSync, so the time is parse + React render + DOM commit (layout and paint excluded).
import {createElement} from 'react'
import {flushSync} from 'react-dom'
import {createRoot} from 'react-dom/client'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {createStreamParser} from 'samemark/stream'
import {StreamMarkdown} from '../../examples/react-chat/StreamMarkdown.jsx'
import {chatAnswer} from '../../bench/perf/chat-text.mjs'
import {fmtMs} from './format.js'

const STEP = 40 // characters per update, as in the benchmark
const CHECK_EVERY = 10
const plugins = [remarkGfm]

export function initDemo() {
  const $ = id => document.getElementById(id)
  const params = new URLSearchParams(location.search)
  const lenSel = $('len'), rateSel = $('rate'), pauseBtn = $('pause'), restartBtn = $('restart'), badge = $('badge')
  if (['10000', '30000'].includes(params.get('len'))) lenSel.value = params.get('len')
  if ([...rateSel.options].some(o => o.value === params.get('rate'))) rateSel.value = params.get('rate')
  const autostart = params.get('autostart') !== '0'

  const elL = $('out-left'), elR = $('out-right')
  const rootL = createRoot(elL), rootR = createRoot(elR)
  const texts = new Map()
  const getText = len => { if (!texts.has(len)) texts.set(len, chatAnswer(len)); return texts.get(len) }
  const sum = a => a.reduce((x, y) => x + y, 0)
  const state = window.__samemarkDemo = {done: false, running: false, updates: 0, checks: 0, mismatches: 0, totalLeft: 0, totalRight: 0}
  let run = null, timer = 0, frame = 0

  function begin() {
    clearTimeout(timer)
    const len = Number(lenSel.value)
    const text = getText(len)
    flushSync(() => { rootL.render(null); rootR.render(null) })
    run = {text, len, total: Math.ceil(len / STEP), pos: 0, n: 0, left: [], right: [], parser: createStreamParser(), checks: 0, bad: 0, firstBad: 0, running: true, done: false}
    Object.assign(state, {done: false, running: true, updates: 0, checks: 0, mismatches: 0, totalLeft: 0, totalRight: 0})
    pauseBtn.textContent = 'Pause'
    pauseBtn.disabled = false
    setBadge('pending', 'Streaming... checking that both panes hold identical HTML')
    paint()
    timer = setTimeout(tick, 30)
  }

  function check() {
    run.checks++
    if (elL.innerHTML !== elR.innerHTML) { run.bad++; run.firstBad ||= run.n }
  }

  function step() {
    const r = run
    const from = r.pos
    r.pos = Math.min(r.len, from + STEP)
    const chunk = r.text.slice(from, r.pos)
    const left = () => { const t0 = performance.now(); flushSync(() => rootL.render(createElement(Markdown, {remarkPlugins: plugins}, r.text.slice(0, r.pos)))); return performance.now() - t0 }
    const right = () => { const t0 = performance.now(); flushSync(() => rootR.render(createElement(StreamMarkdown, {tree: r.parser.push(chunk)}))); return performance.now() - t0 }
    let tl, tr
    if (r.n % 2 === 0) { tl = left(); tr = right() } else { tr = right(); tl = left() }
    r.n++
    r.left.push(tl); r.right.push(tr)
    if (r.n % CHECK_EVERY === 0 || r.pos >= r.len) check()
  }

  function tick() {
    if (!run || !run.running) return
    const t0 = performance.now()
    step()
    state.updates = run.n; state.checks = run.checks; state.mismatches = run.bad
    if (run.pos >= run.len) { finish(); return }
    schedulePaint()
    const rate = Number(rateSel.value)
    const wait = rate ? Math.max(0, 1000 / rate - (performance.now() - t0)) : 0
    timer = setTimeout(tick, wait)
  }

  function finish() {
    run.running = false; run.done = true
    state.running = false; state.done = true
    state.totalLeft = sum(run.left); state.totalRight = sum(run.right)
    pauseBtn.disabled = true
    paint()
    if (run.bad) setBadge('fail', `FAIL: the panes differ (first at update ${run.firstBad}, ${run.bad} of ${run.checks} checks)`)
    else setBadge('pass', `PASS: both panes hold identical HTML (${run.checks} of ${run.checks} checks, last one after the final update)`)
  }

  function setBadge(kind, msg) { badge.className = 'badge ' + kind; badge.textContent = msg }

  function schedulePaint() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint() }) }

  function side(prefix, times, lineEl, ymax) {
    const n = times.length
    $(prefix + '-n').textContent = n.toLocaleString('en-US') + ' / ' + run.total.toLocaleString('en-US')
    $(prefix + '-last').textContent = n ? fmtMs(times[n - 1]) : '-'
    $(prefix + '-mean').textContent = n ? fmtMs(sum(times) / n) : '-'
    $(prefix + '-worst').textContent = n ? fmtMs(Math.max(...times)) : '-'
    $(prefix + '-total').textContent = n ? fmtMs(sum(times)) : '-'
    const w = 300, h = 60, x = i => (run.total > 1 ? (i / (run.total - 1)) * w : 0), y = v => h - 2 - (Math.min(v, ymax) / ymax) * (h - 4)
    let pts = ''
    for (let i = 0; i < n; i++) pts += x(i).toFixed(1) + ',' + y(times[i]).toFixed(1) + ' '
    lineEl.setAttribute('points', pts)
  }

  function paint() {
    if (!run) return
    const ymax = Math.max(1, ...run.left, ...run.right)
    $('scale').textContent = '0 to ' + fmtMs(ymax)
    side('l', run.left, document.querySelector('#l-spark .line'), ymax)
    side('r', run.right, document.querySelector('#r-spark .line'), ymax)
    const a = sum(run.left), b = sum(run.right)
    $('ratio').textContent = run.n && b > 0 ? `So far the left pane has spent ${fmtMs(a)} on updates and the right pane ${fmtMs(b)}: ${(a / b).toFixed(1)}x less on the right.` : ''
    elL.scrollTop = elL.scrollHeight
    elR.scrollTop = elR.scrollHeight
    const sl = document.getElementById('l-spark'), sr = document.getElementById('r-spark')
    const label = `Milliseconds per update over the run, scale ${$('scale').textContent}. Left pane total ${fmtMs(a)}, right pane total ${fmtMs(b)}.`
    sl.setAttribute('aria-label', 'Left pane. ' + label); sr.setAttribute('aria-label', 'Right pane. ' + label)
  }

  pauseBtn.addEventListener('click', () => {
    if (!run || run.done) return
    if (run.running) { run.running = false; state.running = false; clearTimeout(timer); pauseBtn.textContent = 'Resume'; setBadge('pending', 'Paused') }
    else { run.running = true; state.running = true; pauseBtn.textContent = 'Pause'; setBadge('pending', 'Streaming... checking that both panes hold identical HTML'); timer = setTimeout(tick, 0) }
  })
  restartBtn.addEventListener('click', begin)
  lenSel.addEventListener('change', begin)
  // speed changes take effect on the next update, no restart needed

  if (autostart) begin()
  else { setBadge('pending', 'Press Restart to start'); run = {total: Math.ceil(Number(lenSel.value) / STEP), left: [], right: [], n: 0}; paint() }
}
