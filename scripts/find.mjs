// usage: node scripts/find.mjs <path or corpus id> -> prints minimal-ish diff context
import fs from 'node:fs'
import {ref, strip, firstDiff} from '../bench/common.mjs'
import {parse} from '../src/block.js'
import {loadDocs} from '../bench/corpus.mjs'
const f = process.argv[2]
const src = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : loadDocs().find(it => it.id === f || it.id.endsWith('/' + f))?.src
if (src === undefined) { console.error('file not found: ' + f); process.exit(1) }
const a = strip(ref(src)), b = parse(src)
const d = firstDiff(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
if (!d) { console.log('IDENTICAL'); process.exit() }
console.log(JSON.stringify(d).slice(0, 600))
// locate node
let n = a; const re = /\.children\[(\d+)\]/g; let m
const pth = d.path
while ((m = re.exec(pth))) n = n.children[Number(m[1])]
const st = n.position.start.offset, en = n.position.end.offset
const lo = Math.max(0, st - 150), hi = Math.min(src.length, en + 150)
console.log('--- node', n.type, JSON.stringify(n.position))
console.log(JSON.stringify(src.slice(lo, hi)))
