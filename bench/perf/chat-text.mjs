// Deterministic chat-style assistant answer of at least n characters: headings, numbered steps with nested bullets,
// fenced code in several languages, a table, a block quote, task list, bold / italic / inline code / links. Synthetic by
// design (so anyone can regenerate the exact bytes); it mimics the shape of long LLM answers, not any real transcript.
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }
const topics = ['connection pooling', 'cache invalidation', 'retry with backoff', 'schema migrations', 'rate limiting', 'feature flags', 'structured logging', 'background jobs', 'idempotency keys', 'pagination']
const verbs = ['configure', 'measure', 'isolate', 'review', 'document', 'monitor', 'benchmark', 'simplify']
const code = [
  ['js', 'async function withRetry(fn, {retries = 3, base = 200} = {}) {\n  for (let attempt = 0; ; attempt++) {\n    try {\n      return await fn()\n    } catch (err) {\n      if (attempt >= retries) throw err\n      const delay = base * 2 ** attempt + Math.random() * 100\n      await new Promise(r => setTimeout(r, delay))\n    }\n  }\n}'],
  ['python', 'def paginate(items, size=50):\n    """Yield pages of `size` items."""\n    page = []\n    for item in items:\n        page.append(item)\n        if len(page) == size:\n            yield page\n            page = []\n    if page:\n        yield page'],
  ['bash', 'set -euo pipefail\nfor f in migrations/*.sql; do\n  echo "applying $f"\n  psql "$DATABASE_URL" -f "$f"\ndone'],
  ['ts', 'interface Job<T> {\n  id: string\n  payload: T\n  attempts: number\n}\n\nexport function schedule<T>(job: Job<T>, delayMs: number): Promise<void> {\n  return new Promise(resolve => setTimeout(resolve, delayMs))\n}'],
  ['sql', 'SELECT user_id, count(*) AS n\nFROM events\nWHERE created_at > now() - interval \'7 days\'\nGROUP BY user_id\nORDER BY n DESC\nLIMIT 20;']
]
export function chatAnswer(n, seed = 7) {
  const r = rng(seed)
  const pick = a => a[Math.floor(r() * a.length)]
  const out = []
  let len = 0
  const add = s => { out.push(s); len += s.length + 2 }
  add("Great question! Here is a practical breakdown, with the trade-offs spelled out so you can decide what fits your setup.")
  while (len < n) {
    const t = pick(topics)
    add(`## ${t[0].toUpperCase() + t.slice(1)}`)
    add(`The short version: **${pick(verbs)} first, then optimise**. In practice ${t} is easiest to get right when you treat it as a *policy* rather than a one-off fix, and when the numbers come from \`production\` rather than from a guess. See the [reference docs](https://example.com/docs/${t.replace(/ /g, '-')}) and the [design notes](https://example.com/notes#${t.length}) for background.`)
    add([1, 2, 3].map(i => `${i}. **Step ${i}:** ${pick(verbs)} the ${t} settings, then check \`metric_${i}\` against the baseline.\n${[1, 2].map(j => `   - Sub-point ${j}: keep the change small and reversible, and note it in the *changelog*.`).join('\n')}`).join('\n'))
    const [lang, body] = pick(code)
    add('```' + lang + '\n' + body + '\n```')
    add(`| Option | Latency | Cost | Notes |\n|---|---:|---:|---|\n${[1, 2, 3, 4].map(i => `| ${pick(verbs)} ${i} | ${Math.floor(r() * 90 + 10)} ms | $${(r() * 9 + 1).toFixed(2)} | ${pick(['fine for most apps', 'needs a restart', 'works with ~~old~~ new clients', 'see `config.yaml`'])} |`).join('\n')}`)
    if (r() < 0.6) add(`> **Note:** this assumes a single region. If you run in several, repeat the ${t} checks per region and compare.`)
    if (r() < 0.5) add(`- [x] Baseline measured\n- [ ] Roll out to 10% of traffic\n- [ ] Review after a week`)
    add(`Let me know if you want a deeper dive into ${pick(topics)}, or an example tailored to your stack. :tada:`)
  }
  return out.join('\n\n').slice(0, n)
}
