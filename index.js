// samemark: mdast parser identical to mdast-util-from-markdown + GFM, with the real parser as fallback.
// Needs mdast-util-from-markdown (optional peer dependency). Use 'samemark/core' to avoid that import.
import {fromMarkdown} from 'mdast-util-from-markdown'
import {createApi} from './lib/api.js'
import {makeVerify} from './lib/verify.js'

// same call remark-parse makes
const fallback = (text, ctx) => fromMarkdown(text, {...ctx.settings, extensions: ctx.extensions, mdastExtensions: ctx.mdastExtensions})
const api = createApi(fallback, makeVerify(fromMarkdown))
export const parse = api.parse
export const remarkParseFast = api.remarkParseFast
export const check = api.check
export const stats = api.stats
export default remarkParseFast
