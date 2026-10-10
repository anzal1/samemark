// Regenerates the README charts in assets/ (hand-written SVG, light and dark variants, transparent background).
//   node scripts/charts.mjs
// Data, nothing invented:
//   - bench/data/report-38036885270.md  the `report` artifact of the public bench run 38036885270
//     (gh run download 38036885270 -R anzal1/samemark -n report): end to end table, streaming-into-the-DOM table
//   - README.md "Streaming cost" table: bench/stream-bench.mjs, 12 characters per push (CI, private development repo)
import fs from 'node:fs'

const root = new URL('../', import.meta.url).pathname
const RUN = '38036885270'
const report = fs.readFileSync(root + `bench/data/report-${RUN}.md`, 'utf8')
const readme = fs.readFileSync(root + 'README.md', 'utf8')

// ---- parsing -------------------------------------------------------------------------------------------------------
function section(text, heading) {
  const i = text.indexOf(heading)
  if (i < 0) throw new Error('section not found: ' + heading)
  const rest = text.slice(i + heading.length)
  const j = rest.search(/\n#{2,3} /)
  return j < 0 ? rest : rest.slice(0, j)
}
function firstTable(text) {
  const rows = []
  let on = false
  for (const line of text.split('\n')) {
    if (line.startsWith('|')) {
      on = true
      rows.push(line.slice(1, line.lastIndexOf('|')).split('|').map(c => c.trim()))
    } else if (on) break
  }
  return rows.slice(2) // header + separator
}
const ms = s => {
  const m = /^([\d.,]+)\s*(ms|s)\b/.exec(s)
  if (!m) throw new Error('cannot read time: ' + s)
  return Number(m[1].replace(/,/g, '')) * (m[2] === 's' ? 1000 : 1)
}
const clean = s => s.replace(/\*\*/g, '')

const e2e = firstTable(section(report, '### End to end: markdown to HTML with unified')).map(r => ({
  name: r[0], files: Number(r[1]), size: r[2], base: ms(r[3]), baseLabel: r[3], fast: ms(r[4]), fastLabel: r[4], speedup: clean(r[5]), identical: r[7]
}))
if (e2e.length !== 6) throw new Error('expected six inputs, got ' + e2e.length)

const domRows = firstTable(section(report, '### Streaming a 30,000 character answer into the DOM'))
const dom = {}
for (const r of domRows) {
  const cpu = r[0] === 'no throttling' ? '1x' : r[0].replace(' slower', '')
  const key = r[1][1] // a, b, c
  dom[cpu] ??= {}
  dom[cpu][key] = {total: ms(r[3]), totalLabel: r[3].replace(/\s*\(.*$/, ''), times: (/\*\*([\d.]+)x\*\*/.exec(r[3]) || [])[1], same: r[7]}
}
if (Object.keys(dom).length !== 3) throw new Error('expected three CPU levels')

const growthRows = firstTable(section(readme, '### Streaming cost'))
const growth = growthRows.map(r => ({chars: Number(r[0].replace(/[^\d]/g, '')), full: ms(r[1]), fullLabel: r[1], stream: ms(r[2]), streamLabel: r[2], speedup: clean(r[3])}))
if (growth.length !== 3) throw new Error('expected three stream sizes')

// ---- drawing -------------------------------------------------------------------------------------------------------
const themes = {
  light: {ink: '#1f2328', muted: '#59636e', grid: '#d1d9e0', axis: '#818b98', base: '#6a737d', blue: '#1f6feb', green: '#1a7f64'},
  dark: {ink: '#e6edf3', muted: '#9198a1', grid: '#30363d', axis: '#6e7681', base: '#9aa4b2', blue: '#58a6ff', green: '#3fb68b'}
}
const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const W = 880
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const f1 = n => (Math.round(n * 10) / 10).toString()

function svg({height, title, desc, body, t}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="t d" font-family="${FONT}" font-size="13">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
${body}
</svg>
`
}
const text = (x, y, s, {fill, size = 13, weight = 400, anchor = 'start'} = {}) =>
  `<text x="${f1(x)}" y="${f1(y)}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`
const rect = (x, y, w, h, fill) => `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(w, 1))}" height="${h}" rx="1.5" fill="${fill}"/>`
const line = (x1, y1, x2, y2, stroke, w = 1) => `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${stroke}" stroke-width="${w}"/>`
// Wraps to a new row when an item would run past the right margin (label width estimated generously, 7.6 px per character at 13 px).
function legend(items, x, y, t) {
  let out = '', cx = x, cy = y
  for (const [color, label] of items) {
    const w = 16 + label.length * 7.6
    if (cx > x && cx + w > W - 24) { cx = x; cy += 18 }
    out += rect(cx, cy - 10, 10, 10, color) + text(cx + 16, cy, label, {fill: t.ink})
    cx += w + 26
  }
  return out
}
function footer(lines, h, t) {
  return lines.map((l, i) => text(24, h - 4 - (lines.length - 1 - i) * 15, l, {fill: t.muted, size: 11.5})).join('')
}
function header(title, subtitle, t) {
  return text(24, 28, title, {fill: t.ink, size: 17, weight: 600}) + text(24, 49, subtitle, {fill: t.muted})
}

// a. end to end speedup ------------------------------------------------------------------------------------------------
function chartE2E(t) {
  const x0 = 250, x1 = 700, top = 112, pitch = 46, maxV = 5000
  const X = v => x0 + (v / maxV) * (x1 - x0)
  const bottom = top + e2e.length * pitch, h = bottom + 58
  let b = header('Markdown to HTML, remark-parse vs samemark', 'unified + remark-gfm + remark-rehype + rehype-stringify, whole run, time per input (lower is better)', t)
  b += legend([[t.base, 'remark-parse'], [t.blue, 'samemark']], 24, 76, t)
  b += text(870, top - 12, 'speedup', {fill: t.muted, size: 12, anchor: 'end'})
  for (const v of [0, 1000, 2000, 3000, 4000, 5000]) {
    b += line(X(v), top - 6, X(v), bottom, t.grid)
    b += text(X(v), bottom + 16, v === 0 ? '0' : v / 1000 + ' s', {fill: t.muted, size: 12, anchor: 'middle'})
  }
  e2e.forEach((r, i) => {
    const y = top + i * pitch
    b += text(24, y + 14, r.name.replace(/ \(240 generated documents\)/, ''), {fill: t.ink})
    b += text(24, y + 31, `${r.files} ${r.files === 1 ? 'file' : 'files'}, ${r.size}`, {fill: t.muted, size: 12})
    b += rect(x0, y + 3, X(r.base) - x0, 10, t.base) + text(X(r.base) + 7, y + 13, r.baseLabel, {fill: t.ink, size: 12})
    b += rect(x0, y + 17, X(r.fast) - x0, 10, t.blue) + text(X(r.fast) + 7, y + 27, r.fastLabel, {fill: t.ink, size: 12})
    b += text(870, y + 20, r.speedup, {fill: t.ink, size: 15, weight: 600, anchor: 'end'})
  })
  b += line(x0, top - 6, x0, bottom, t.axis)
  b += footer([`Source: bench workflow, run ${RUN} (public; GitHub Actions ubuntu24, Node 24.21.0, median of 7 rounds).`, 'HTML identical on every file. Linear axis.'], h, t)
  return svg({
    height: h, t,
    title: 'End to end markdown to HTML time, remark-parse versus samemark',
    desc: 'Horizontal bars for six inputs. ' + e2e.map(r => `${r.name}: remark-parse ${r.baseLabel}, samemark ${r.fastLabel}, ${r.speedup} faster`).join('; ') + `. Source: bench workflow run ${RUN}.`,
    body: b
  })
}

// b. streaming into the DOM, small multiples per CPU level, shared linear axis -----------------------------------------
function chartDom(t) {
  const x0 = 250, x1 = 700, top = 116, maxV = 80000
  const X = v => x0 + (v / maxV) * (x1 - x0)
  const panelH = 100
  const bottom = top + 3 * panelH - 12, h = bottom + 58
  const names = {a: '(a) react-markdown', b: '(b) react-markdown + samemark', c: '(c) samemark/stream, memoised'}
  const colors = {a: t.base, b: t.blue, c: t.green}
  let b = header('Streaming a 30,000 character answer into the DOM', 'Chromium, main-thread time summed over 750 pushes of 40 characters (lower is better); same axis in all three panels', t)
  b += legend([[t.base, '(a) react-markdown, whole message per push'], [t.blue, '(b) react-markdown + samemark'], [t.green, '(c) samemark/stream + memoised blocks']], 24, 76, t)
  for (const v of [0, 20000, 40000, 60000, 80000]) {
    b += line(X(v), top - 8, X(v), bottom, t.grid)
    b += text(X(v), bottom + 16, v === 0 ? '0' : v / 1000 + ' s', {fill: t.muted, size: 12, anchor: 'middle'})
  }
  b += line(x0, top - 8, x0, bottom, t.axis)
  ;[['1x', 'No CPU throttling'], ['4x', 'CPU 4x slower'], ['6x', 'CPU 6x slower']].forEach(([k, label], i) => {
    const y = top + i * panelH
    b += text(24, y + 8, label, {fill: t.ink, weight: 600})
    for (const [j, key] of ['a', 'b', 'c'].entries()) {
      const r = dom[k][key]
      const by = y + 16 + j * 23
      b += text(x0 - 10, by + 10, names[key], {fill: t.ink, size: 12, anchor: 'end'})
      b += rect(x0, by, X(r.total) - x0, 12, colors[key])
      b += text(X(r.total) + 7, by + 10.5, r.totalLabel + (r.times ? `  (${r.times}x less than a)` : ''), {fill: t.ink, size: 12})
    }
  })
  b += footer([`Source: bench workflow, run ${RUN}, job "react-markdown in Chromium" (Chromium 156.0.8078.4, React 19 production).`, 'CPU throttling via DevTools, a proxy for a slower device. DOM equal to (a) in 31 of 31 checks per cell.'], h, t)
  return svg({
    height: h, t,
    title: 'Main-thread time streaming a 30,000 character answer into the DOM',
    desc: 'Grouped horizontal bars, one panel per CPU throttle level. ' + ['1x', '4x', '6x'].map(k => `${k === '1x' ? 'No throttling' : k + ' slower'}: ` + ['a', 'b', 'c'].map(x => `${names[x]} ${dom[k][x].totalLabel}`).join(', ')).join('; ') + `. Source: bench workflow run ${RUN}.`,
    body: b
  })
}

// c. cost growth while streaming, one axis ----------------------------------------------------------------------------
function chartGrowth(t) {
  const px0 = 200, px1 = 720, py0 = 112, py1 = 322, maxX = 110000, maxY = 10000
  const X = v => px0 + (v / maxX) * (px1 - px0)
  const Y = v => py1 - (v / maxY) * (py1 - py0)
  const h = 490
  let b = header('Cost of streaming an answer, by answer length', 'Total time to push the whole answer in 12 character chunks, parser only (lower is better)', t)
  b += legend([[t.base, 'full re-parse on every push'], [t.green, 'samemark/stream (createStreamParser)']], 24, 76, t)
  for (const v of [0, 2000, 4000, 6000, 8000, 10000]) {
    b += line(px0, Y(v), px1, Y(v), v === 0 ? t.axis : t.grid)
    b += text(px0 - 8, Y(v) + 4, v.toLocaleString('en-US'), {fill: t.muted, size: 12, anchor: 'end'})
  }
  b += text(24, py0 - 14, 'ms', {fill: t.muted, size: 12})
  const poly = (key, color) => `<polyline points="${growth.map(g => `${f1(X(g.chars))},${f1(Y(g[key]))}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>` +
    growth.map(g => `<circle cx="${f1(X(g.chars))}" cy="${f1(Y(g[key]))}" r="3.5" fill="${color}"/>`).join('')
  b += poly('full', t.base) + poly('stream', t.green)
  // end labels
  const last = growth[growth.length - 1]
  b += text(X(last.chars) - 4, Y(last.full) - 12, last.fullLabel, {fill: t.ink, size: 12, anchor: 'end'})
  b += text(X(last.chars) - 4, Y(last.stream) - 12, last.streamLabel, {fill: t.ink, size: 12, anchor: 'end'})
  // x ticks and the value table, aligned under the three measured sizes
  for (const g of growth) b += line(X(g.chars), py1, X(g.chars), py1 + 5, t.axis)
  const rows = [['answer length', g => g.chars.toLocaleString('en-US') + ' chars', null], ['full re-parse', g => g.fullLabel, t.base], ['samemark/stream', g => g.streamLabel, t.green], ['speedup', g => g.speedup, null]]
  rows.forEach(([label, fn, color], i) => {
    const y = py1 + 30 + i * 24
    if (color) b += rect(24, y - 10, 10, 10, color)
    b += text(color ? 40 : 24, y, label, {fill: i === 0 ? t.muted : t.ink, size: 12})
    for (const g of growth) b += text(X(g.chars), y, fn(g), {fill: i === 0 ? t.muted : t.ink, size: 12, weight: i === 3 ? 600 : 400, anchor: 'middle'})
  })
  b += footer(['Source: bench/stream-bench.mjs in CI (ubuntu-latest, private development repo), numbers as published in the README.', 'Three measured sizes; the lines only connect the points.'], h, t)
  return svg({
    height: h, t,
    title: 'Total time to stream an answer, full re-parse per push versus samemark/stream',
    desc: 'Line chart with three measured answer lengths. ' + growth.map(g => `${g.chars.toLocaleString('en-US')} characters: full re-parse ${g.fullLabel}, samemark/stream ${g.streamLabel}, ${g.speedup}`).join('; ') + '. Full re-parse grows faster than linearly, the stream parser stays near flat.',
    body: b
  })
}

fs.mkdirSync(root + 'assets', {recursive: true})
const charts = {'e2e-speedup': chartE2E, 'stream-dom': chartDom, 'stream-growth': chartGrowth}
for (const [name, fn] of Object.entries(charts)) {
  for (const [mode, t] of Object.entries(themes)) {
    const file = `assets/${name}-${mode}.svg`
    fs.writeFileSync(root + file, fn(t))
    console.log('wrote', file, fs.statSync(root + file).size, 'bytes')
  }
}
