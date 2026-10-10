import {unified} from 'unified'
import remarkGfm from 'remark-gfm'
import remarkParseFast, {parse, stats, check} from 'samemark'
import coreParse, {parse as coreParseFn} from 'samemark/core'
import {createStreamParser} from 'samemark/stream'
import type {Root} from 'mdast'

const tree: Root = parse('# hi')
const tree2: Root = coreParseFn('# hi', {strict: true})
const n: number = stats.fast
const reason: string | null = check([], [])
const p = unified().use(remarkParseFast, {warn: true, onFallback: (r: string) => void r}).use(remarkGfm)
const root: Root = p.parse('x')
unified().use(coreParse).use(remarkGfm)
// @ts-expect-error unknown option
parse('x', {nope: 1})
const sp = createStreamParser({frontmatter: ['yaml', 'toml'], math: {single: false}})
const streamed: Root = sp.push('# hi')
sp.reset()
const final: Root = sp.end()
// @ts-expect-error push takes a string
sp.push(1)
export {streamed, final, tree, tree2, n, reason, root}
