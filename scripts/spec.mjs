import fs from 'node:fs'
const specText = fs.readFileSync(new URL('../node_modules/commonmark-spec/spec.txt', import.meta.url), 'utf8')
const re = /^`{32} example[^\n]*\n([\s\S]*?)^\.\n([\s\S]*?)^`{32}$/gm
let m, n = 0
while ((m = re.exec(specText))) { n++; if (n === Number(process.argv[2])) { console.log(JSON.stringify(m[1].replace(/→/g, '\t'))) } }
