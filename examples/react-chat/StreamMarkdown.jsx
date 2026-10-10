// Streaming markdown for a chat UI: tokens go into createStreamParser, finished blocks keep their object identity,
// and React.memo skips every block whose node did not change. The output is the same HTML react-markdown produces
// for the whole message (checked in test/stream.test.mjs and in the Chromium benchmark).
//
//   const {tree, push, reset} = useMarkdownStream()
//   ... push(chunk) for every streamed token ...
//   return <StreamMarkdown tree={tree} />
//
// Footnotes are the one thing a per-block render cannot do (the footnote section is built from the whole tree), so a
// message that contains footnote definitions is rendered as a whole instead.
import {memo, useCallback, useRef, useState} from 'react'
import {Fragment, jsx, jsxs} from 'react/jsx-runtime'
import {toHast} from 'mdast-util-to-hast'
import {toJsxRuntime} from 'hast-util-to-jsx-runtime'
import {urlAttributes} from 'html-url-attributes'
import {defaultUrlTransform} from 'react-markdown'
import {createStreamParser} from 'samemark/stream'

const EMPTY = {type: 'root', children: []}

// the same post-processing react-markdown applies to the hast tree: raw HTML shown as text, URLs sanitised
function clean(node) {
  if (node.children) {
    node.children = node.children.map(child => (child.type === 'raw' ? {type: 'text', value: child.value} : child))
    node.children.forEach(clean)
  }
  if (node.type === 'element') {
    for (const key of Object.keys(urlAttributes)) {
      if (Object.hasOwn(node.properties, key) && (urlAttributes[key] === null || urlAttributes[key].includes(node.tagName))) {
        node.properties[key] = defaultUrlTransform(String(node.properties[key] || ''))
      }
    }
  }
}

function toReact(root) {
  const hast = toHast(root, {allowDangerousHtml: true})
  clean(hast)
  return toJsxRuntime(hast, {Fragment, ignoreInvalidStyle: true, jsx, jsxs, passKeys: true, passNode: true})
}

// definitions travel with every block so reference links resolve; they render nothing themselves
const Block = memo(function Block({node, definitions}) {
  return toReact({type: 'root', children: [node, ...definitions]})
}, (a, b) => a.node === b.node && a.definitionsKey === b.definitionsKey)

export function StreamMarkdown({tree}) {
  if (tree.children.some(node => node.type === 'footnoteDefinition')) return toReact(tree)
  const definitions = tree.children.filter(node => node.type === 'definition')
  const definitionsKey = definitions.map(d => `${d.identifier}\0${d.url}\0${d.title}`).join('\n')
  const out = []
  tree.children.forEach((node, i) => {
    if (node.type === 'definition') return
    if (out.length) out.push('\n')
    out.push(jsx(Block, {node, definitions, definitionsKey}, i))
  })
  return jsx(Fragment, {children: out})
}

export function useMarkdownStream(options) {
  const parser = useRef(null)
  if (parser.current === null) parser.current = createStreamParser(options)
  const [tree, setTree] = useState(EMPTY)
  const push = useCallback(chunk => setTree(parser.current.push(chunk)), [])
  const reset = useCallback(() => { parser.current.reset(); setTree(EMPTY) }, [])
  return {tree, push, reset}
}
