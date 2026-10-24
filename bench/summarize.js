const fs=require('fs');
for (const f of process.argv.slice(2)) {
  const r=JSON.parse(fs.readFileSync(f,'utf8'));
  console.log(`\n== ${f}  cold ready ${r.cold.readyMs}ms (first usable ${r.cold.firstUsableMs}ms, ${r.cold.files} files/${r.cold.symbols} sym, +${r.cold.rssDeltaMb}MB) | warm ${r.warm.readyMs}ms (restored ${r.warm.restored}, parsed ${r.warm.parsed}) | incr ${r.incremental?.refreshMs}ms fresh=${r.incremental?.newSymbolVisibleImmediately} | rss ${r.rssMb}MB`);
  console.log('id'.padEnd(24),'eng p50/p95','tok'.padStart(6),'fRec','tRec','|','rg p50','tok'.padStart(7),'fRec');
  let ef=0,rf=0,et=0,rt=0,n=0;
  for (const q of r.queries){ n++; ef+=q.engine.fileRecall; rf+=q.rg.fileRecall; et+=q.engine.tokens; rt+=q.rg.tokens;
    console.log(q.id.padEnd(24),String(q.engine.p50).padStart(5)+'/'+String(q.engine.p95).padEnd(6),String(q.engine.tokens).padStart(6),q.engine.fileRecall.toFixed(2),q.engine.textRecall.toFixed(2),'|',String(q.rg.p50).padStart(6),String(q.rg.tokens).padStart(7),q.rg.fileRecall.toFixed(2)); }
  console.log(`MEAN engine fileRecall ${(ef/n).toFixed(2)} tokens ${Math.round(et/n)} | rg fileRecall ${(rf/n).toFixed(2)} tokens ${Math.round(rt/n)}`);
}
