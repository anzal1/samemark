// One row per common remark setup: does remarkParseFast take the fast path or fall back?
// Used by test/plugin.test.mjs and scripts/compat-table.mjs (which prints the README table).
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import remarkDirective from 'remark-directive'
import remarkMdx from 'remark-mdx'
import remarkBreaks from 'remark-breaks'
import remarkSmartypants from 'remark-smartypants'

const disable = function () { const d = this.data(); (d.micromarkExtensions ||= []).push({disable: {null: ['codeIndented']}}) }
const unknown = function () { const d = this.data(); (d.micromarkExtensions ||= []).push({text: {64: {name: 'atSign', tokenize(effects, ok) { return function start(code) { effects.enter('data'); effects.consume(code); effects.exit('data'); return ok } }}}}) }

export const cases = [
  {label: 'remark-gfm', plugins: [remarkGfm], fast: true},
  {label: 'remark-gfm twice', plugins: [remarkGfm, remarkGfm], fast: true},
  {label: 'remark-gfm with `tablePipeAlign` / `tableCellPadding` (serialisation options only)', plugins: [[remarkGfm, {tablePipeAlign: false, tableCellPadding: false}]], fast: true},
  {label: 'remark-gfm + remark-breaks (tree transform only)', plugins: [remarkGfm, remarkBreaks], fast: true},
  {label: 'remark-gfm + remark-smartypants (tree transform only)', plugins: [remarkGfm, remarkSmartypants], fast: true},
  {label: 'remark-gfm with `singleTilde: false`', plugins: [[remarkGfm, {singleTilde: false}]], fast: false},
  {label: 'remark-gfm + remark-frontmatter (yaml)', plugins: [remarkGfm, remarkFrontmatter], fast: true},
  {label: 'remark-gfm + remark-frontmatter `[\'yaml\', \'toml\']`', plugins: [remarkGfm, [remarkFrontmatter, ['yaml', 'toml']]], fast: true, doc: 'toml'},
  {label: 'remark-gfm + remark-frontmatter `\'toml\'`', plugins: [remarkGfm, [remarkFrontmatter, 'toml']], fast: true, doc: 'toml'},
  {label: 'remark-gfm + remark-frontmatter with a custom `fence` (same type, other fence)', plugins: [remarkGfm, [remarkFrontmatter, [{type: 'yaml', fence: {open: '---x', close: '---'}}]]], fast: false},
  {label: 'remark-gfm + remark-frontmatter with a custom matter type', plugins: [remarkGfm, [remarkFrontmatter, [{type: 'custom', fence: {open: '<!--', close: '-->'}}]]], fast: false},
  {label: 'remark-gfm + remark-frontmatter with `anywhere: true`', plugins: [remarkGfm, [remarkFrontmatter, [{type: 'yaml', marker: '-', anywhere: true}]]], fast: false},
  {label: 'remark-gfm + remark-math', plugins: [remarkGfm, remarkMath], fast: true},
  {label: 'remark-gfm + remark-math with `singleDollarTextMath: false`', plugins: [remarkGfm, [remarkMath, {singleDollarTextMath: false}]], fast: true},
  {label: 'remark-gfm + remark-frontmatter + remark-math', plugins: [remarkGfm, remarkFrontmatter, remarkMath], fast: true},
  {label: 'remark-frontmatter + remark-math without remark-gfm', plugins: [remarkFrontmatter, remarkMath], fast: false},
  {label: 'remark-gfm + remark-directive', plugins: [remarkGfm, remarkDirective], fast: false},
  {label: 'remark-gfm + remark-frontmatter + remark-directive', plugins: [remarkGfm, remarkFrontmatter, remarkDirective], fast: false},
  {label: 'remark-mdx (MDX)', plugins: [remarkMdx], fast: false},
  {label: 'remark-gfm + remark-mdx', plugins: [remarkGfm, remarkMdx], fast: false},
  {label: 'no remark-gfm (CommonMark only)', plugins: [], fast: false},
  {label: 'unknown micromark construct', plugins: [remarkGfm, unknown], fast: false},
  {label: 'micromark `disable` entry', plugins: [remarkGfm, disable], fast: false}
]
const body = '# Hi *there*\n\n- [x] done ~~old~~ www.example.com\n\n| a | b |\n|---|---|\n| `x\\|y` | [l](u) |\n\ntext[^1]\n\n[^1]: note\n\n---\ntitle: x\n---\n\n$$\na\n$$\n\n:::note\nd\n:::\n\n<b>{1}</b>\n\n~a~\n'
export const sample = '---\ntitle: x\ntags: [a, b]\n---\n\n' + body
export const sampleToml = '+++\ntitle = "x"\n+++\n\n' + body
export const docFor = c => (c.doc === 'toml' ? sampleToml : sample)
