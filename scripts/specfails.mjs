import fs from 'node:fs'
import {ref, strip, firstDiff} from '../bench/common.mjs'
import {parse} from '../src/block.js'
const specText = fs.readFileSync(new URL('../node_modules/commonmark-spec/spec.txt', import.meta.url), 'utf8')
const re = /^`{32} example[^\n]*\n([\s\S]*?)^\.\n([\s\S]*?)^`{32}$/gm
let m, n = 0
while ((m = re.exec(specText))) { n++; const src = m[1].replace(/→/g, '\t'); const a = strip(ref(src)), b = parse(src)
  const d = firstDiff(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); if (d) console.log(n, JSON.stringify(src), d.path, JSON.stringify(d.a)?.slice(0,80), JSON.stringify(d.b)?.slice(0,80)) }
