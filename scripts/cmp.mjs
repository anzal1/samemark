import {ref, strip, firstDiff} from '../bench/common.mjs'
import {parse} from '../src/block.js'
import fs from 'node:fs'
const arg = process.argv[2]
const src = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg.replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\r/g,'\r')
function p(n){return n.position.start.line+':'+n.position.start.column+'('+n.position.start.offset+')-'+n.position.end.line+':'+n.position.end.column+'('+n.position.end.offset+')'}
function show(n, ind=''){
  const {type,children,position,...rest}=n
  console.log(ind+type+' '+p(n)+' '+JSON.stringify(rest))
  for(const c of children||[]) show(c, ind+'  ')
}
const a = strip(ref(src)); const b = parse(src)
const d = firstDiff(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
if (!d) { console.log('IDENTICAL'); if (process.argv[3]) show(a); process.exit(0) }
console.log('DIFF', JSON.stringify(d).slice(0, 400))
console.log('--- ref'); show(a); console.log('--- mine'); show(b)
