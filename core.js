// samemark/core: the fast parser with no fallback import. Unsupported extensions throw (unless a fallback
// function is passed, or remark-parse was set up before this plugin, in which case it is used).
import {createApi} from './lib/api.js'

const api = createApi(null, null)
export const parse = api.parse
export const remarkParseFast = api.remarkParseFast
export const check = api.check
export const stats = api.stats
export default remarkParseFast
