// samemark/stream: incremental parsing for streamed text (LLM chat UIs).
//   const s = createStreamParser()
//   const tree = s.push(chunk)   // equals parse(everything pushed so far), positions included
// Finished top-level blocks keep their object identity from push to push; the cost of a push is the new text plus the
// unfinished tail. Supports stock GFM, optionally with frontmatter and math (`{frontmatter, math}`). No fallback: for
// other extensions parse the whole message with the main entry instead.
export {createStreamParser} from './src/stream.js'
