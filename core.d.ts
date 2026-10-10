import type {Plugin} from 'unified'
import type {Root} from 'mdast'
import type {Options} from './lib/types.js'

export type {Options, ParseOptions, FallbackContext, Stats} from './lib/types.js'
export {parse, check, stats} from './lib/types.js'

/** Unified parser plugin: stock GFM takes the fast path; anything else needs a fallback (see `Options.fallback`). */
export const remarkParseFast: Plugin<[(Options | null | undefined)?], string, Root>
export default remarkParseFast
