import {ref, strip} from '../bench/common.mjs'
const src = process.argv[2].replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\r/g,'\r')
const t = strip(ref(src))
function p(n){return n.position.start.line+':'+n.position.start.column+'('+n.position.start.offset+')-'+n.position.end.line+':'+n.position.end.column+'('+n.position.end.offset+')'}
function show(n, ind=''){
  const {type,children,position,...rest}=n
  console.log(ind+type+' '+p(n)+' '+JSON.stringify(rest))
  for(const c of children||[]) show(c, ind+'  ')
}
show(t)
