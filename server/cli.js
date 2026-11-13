// CLI: `node server/cli.js scan [count]` runs the crawl without the web server and prints the funnel + finalists.
import { Scanner } from './scanner.js';

const [cmd, countArg] = process.argv.slice(2);
const scanner = new Scanner({ dataDir: process.env.HL_DATA_DIR || 'data' });
if (cmd === 'scan') {
  if (countArg) scanner.config.universe.deepScanCount = Number(countArg);
  const timer = setInterval(() => {
    const p = scanner.progress;
    process.stdout.write(`\r${p.phase} ${p.done}/${p.total} ${p.current || ''}   `);
  }, 2000);
  await scanner.runScan({ refreshUniverse: true });
  clearInterval(timer);
} else if (cmd === 'reanalyze') {
  await scanner.reanalyzeAll();
}
const { funnel, finalists, rows } = scanner.ranking();
console.log('\nFunnel:');
for (const f of funnel) console.log(`  ${String(f.remaining).padStart(5)}  ${f.label}`);
console.log(`\nFinalists (${finalists.length} of ${rows.length}):`);
for (const r of finalists) console.log(`  ${r.metrics.address}  score ${r.score.toFixed(1)}  sharpe ${r.metrics.annSharpe.toFixed(2)}  dsr ${r.metrics.dsr.toFixed(2)}`);
if (scanner.progress.errors.length) console.log('\nErrors:', scanner.progress.errors.slice(0, 10));
process.exit(0);
