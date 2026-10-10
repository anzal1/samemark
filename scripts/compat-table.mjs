// Prints the plugin compatibility table of the README from real behaviour (same cases as test/plugin.test.mjs).
import {unified} from 'unified'
import * as full from '../index.js'
import {cases} from '../test/compat-cases.mjs'

console.log('| Setup | Path | Reported reason |\n|---|---|---|')
for (const c of cases) {
  const p = unified().use(full.default)
  for (const pl of c.plugins) p.use(...[].concat(pl))
  const before = full.stats.fallback
  p.parse('x')
  const fell = full.stats.fallback > before
  console.log(`| ${c.label} | ${fell ? 'fallback (real parser)' : '**fast**'} | ${fell ? '`' + full.stats.lastFallbackReason.replace(/\|/g, '\\|') + '`' : ''} |`)
}
