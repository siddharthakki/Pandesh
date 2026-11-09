import { execFileSync } from 'node:child_process';
const text = process.argv[2];
const js = `(async()=>{const t=document.querySelector('textarea'); if(!t) return 'no composer';
  const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t, ${JSON.stringify(text)});
  t.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,300));
  t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
  await new Promise(r=>setTimeout(r,800)); return 'sent; composer now: '+JSON.stringify(t.value.slice(0,40));})()`;
console.log(execFileSync('node', ['cdp.mjs', '9482', 'eval', js], { encoding: 'utf8', cwd: import.meta.dirname }));
