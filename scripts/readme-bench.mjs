// Puts the benchmark report into README.md between the bench markers.
//   node scripts/readme-bench.mjs report.md          (report.md = the `report` artifact of the bench workflow)
import fs from 'node:fs'

// the bundle size table lives in its own README section
let report = fs.readFileSync(process.argv[2], 'utf8')
const cut = report.indexOf('### Bundle sizes')
if (cut >= 0) report = report.slice(0, cut)
report = report.trim()
const file = new URL('../README.md', import.meta.url).pathname
const text = fs.readFileSync(file, 'utf8')
const a = '<!-- bench:start -->', b = '<!-- bench:end -->'
const i = text.indexOf(a), j = text.indexOf(b)
if (i < 0 || j < 0) throw new Error('bench markers not found in README.md')
// headings inside the report are ### ; keep them
fs.writeFileSync(file, text.slice(0, i + a.length) + '\n\n' + report + '\n\n' + text.slice(j))
console.log('README.md updated from', process.argv[2])
