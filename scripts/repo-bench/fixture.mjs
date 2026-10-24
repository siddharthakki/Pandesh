// Deterministic synthetic repository generator for the repository-graph benchmark.
//
// Produces a monorepo-shaped tree (npm-style packages with a TS core and a Python slice), with KNOWN ground truth so
// definition / reference / architecture quality can be measured, not just speed. Same seed + same size = same tree.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREAS = ['api', 'core', 'data', 'ui', 'util', 'net', 'auth', 'jobs'];

async function writeMany(files, concurrency = 128) {
  let cursor = 0;
  const entries = [...files];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < entries.length) {
      const [full, content] = entries[cursor++];
      await fs.mkdir(path.dirname(full), { recursive: true }).catch(() => undefined);
      await fs.writeFile(full, content);
    }
  }));
}

/**
 * @param {string} root target directory (must be outside any working tree)
 * @param {number} fileTarget approximate number of files
 * @param {number} seed
 * @returns ground truth { symbols, packages, files, hubs }
 */
export async function generate(root, fileTarget, seed = 1337) {
  const rand = mulberry32(seed);
  const filesPerPackage = 160;
  const packageCount = Math.max(4, Math.round(fileTarget / filesPerPackage));
  const truth = { seed, fileTarget, packages: [], symbols: [], files: 0 };
  const batch = [];
  let fileCount = 0;
  const flush = async () => { if (batch.length) { const chunk = batch.splice(0, batch.length); await writeMany(chunk); } };
  const add = (rel, content) => { batch.push([path.join(root, rel), content]); fileCount++; };

  const pkgMeta = [];
  for (let p = 0; p < packageCount; p++) pkgMeta.push({ index: p, dir: `packages/pkg-${String(p).padStart(5, '0')}`, name: `@bench/pkg-${String(p).padStart(5, '0')}`, python: p % 5 === 4 });

  for (const pkg of pkgMeta) {
    const modules = [];
    const modCount = Math.max(8, Math.round(filesPerPackage * 0.82));
    const hubCount = 3;
    for (let m = 0; m < modCount; m++) {
      const area = AREAS[m % AREAS.length];
      modules.push({ m, area, sym: `Svc${pkg.index}x${m}`, rel: pkg.python ? `${pkg.dir}/${area}/mod_${m}.py` : `${pkg.dir}/src/${area}/mod${m}.ts` });
    }
    const hubs = modules.slice(0, hubCount);
    const importersOf = new Map(modules.map(mod => [mod.sym, []]));

    // manifest + readme + entry
    if (pkg.python) {
      add(`${pkg.dir}/pyproject.toml`, `[project]\nname = "pkg-${pkg.index}"\n`);
      add(`${pkg.dir}/README.md`, `# pkg-${pkg.index}\nPython service ${pkg.index}.\n`);
      add(`${pkg.dir}/__init__.py`, '');
    } else {
      add(`${pkg.dir}/package.json`, JSON.stringify({ name: pkg.name, main: 'src/index.ts', dependencies: {} }));
      add(`${pkg.dir}/README.md`, `# ${pkg.name}\nPackage ${pkg.index}: ${AREAS[pkg.index % AREAS.length]} services.\n`);
    }

    const importLinesFor = (mod) => {
      const targets = new Set();
      const count = 2 + Math.floor(rand() * 3);
      while (targets.size < count) {
        const pick = rand() < 0.45 ? hubs[Math.floor(rand() * hubCount)] : modules[Math.floor(rand() * modules.length)];
        if (pick.m !== mod.m && pick.m < mod.m + 40) targets.add(pick);
        else if (pick.m !== mod.m) targets.add(modules[(mod.m + 1) % modules.length]);
      }
      return [...targets];
    };

    for (const mod of modules) {
      const targets = importLinesFor(mod);
      const decoy = rand() < 0.05;
      if (pkg.python) {
        const lines = targets.map(t => (t.area === mod.area ? `from .mod_${t.m} import ${t.sym}` : `from ..${t.area}.mod_${t.m} import ${t.sym}`)).join('\n');
        add(mod.rel, `${lines}\n\nclass ${mod.sym}:\n    """Service ${mod.sym}."""\n\n    def run(self):\n        return [${targets.map(t => `${t.sym}()`).join(', ')}]\n\n\ndef make_${mod.sym.toLowerCase()}():\n    return ${mod.sym}()\n\nLIMIT_${mod.m} = ${mod.m}\n`);
        if (mod.m % 10 === 0) add(`${pkg.dir}/tests/test_mod_${mod.m}.py`, `from ..${mod.area}.mod_${mod.m} import ${mod.sym}\n\ndef test_${mod.m}():\n    assert ${mod.sym}()\n`);
      } else {
        const rels = (t) => `${t.area === mod.area ? '.' : `../${t.area}`}/mod${t.m}`;
        const importLines = targets.map(t => `import { ${t.sym} } from '${rels(t)}';`).join('\n');
        const ext = rand() < 0.3 && mod.m > 4 ? ` extends ${modules[mod.m - 1 - Math.floor(rand() * 3)].sym}` : '';
        const base = ext ? ext.trim().split(' ')[1] : undefined;
        const extra = base ? `import { ${base} } from '${rels(modules.find(x => x.sym === base))}';\n` : '';
        add(mod.rel, `${extra}${importLines}\n\nexport interface I${mod.sym} { run(): number }\n\nexport class ${mod.sym}${ext} implements I${mod.sym} {\n  run(): number {\n    return ${targets.map(t => `new ${t.sym}().run()`).join(' + ')};\n  }\n}\n\nexport function make${mod.sym}() {\n  return new ${mod.sym}();\n}\n\nexport const LIMIT_${mod.m} = ${mod.m};\n`);
        if (mod.m % 10 === 0) add(mod.rel.replace(/\.ts$/, '.test.ts'), `import { ${mod.sym} } from './mod${mod.m}';\ntest('${mod.sym}', () => { expect(new ${mod.sym}().run()).toBeDefined(); });\n`);
        if (decoy) add(`${pkg.dir}/tests/fixtures/decoy_${mod.m}.test.ts`, `class ${mod.sym} { /* local test double, not the real one */ }\n`);
      }
      for (const t of targets) importersOf.get(t.sym).push(mod.rel);
    }
    if (!pkg.python) {
      add(`${pkg.dir}/src/index.ts`, hubs.map(h => `export * from './${h.area}/mod${h.m}';`).join('\n') + '\n');
    }
    truth.packages.push({ name: pkg.name, dir: pkg.dir, python: pkg.python, manifest: pkg.python ? `${pkg.dir}/pyproject.toml` : `${pkg.dir}/package.json`, entry: pkg.python ? undefined : `${pkg.dir}/src/index.ts`, hubs: hubs.map(h => h.rel) });
    for (const mod of modules) {
      const users = importersOf.get(mod.sym);
      if (users.length > 0 && rand() < 0.15) truth.symbols.push({ name: mod.sym, file: mod.rel, importers: users, hub: hubs.includes(mod) });
    }
    if (batch.length > 4000) await flush();
  }
  await flush();
  truth.files = fileCount;
  return truth;
}
