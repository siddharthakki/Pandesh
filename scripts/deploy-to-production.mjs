import * as fs from 'node:fs';
import * as path from 'node:path';

function copyRecursive(src, dest, excludeFiles = []) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (excludeFiles.includes(entry)) continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry), excludeFiles);
    }
    return;
  }
  const basename = path.basename(src);
  if (excludeFiles.includes(basename)) return;
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.copyFileSync(src, dest);
}

async function main() {
  const srcDir = path.resolve('dist/pandesh-win32-x64');
  const targetDir = 'E:\\Pandesh';

  if (!fs.existsSync(srcDir)) throw new Error(`Source package ${srcDir} does not exist`);
  if (!fs.existsSync(targetDir)) throw new Error(`Target install ${targetDir} does not exist`);

  console.log(`Deploying Build 159 from ${srcDir} to ${targetDir}...`);

  // Exclude uninstaller files created by InnoSetup
  const exclude = ['unins000.exe', 'unins000.dat', 'INSTALL.txt', 'installer-payload-manifest.json'];

  copyRecursive(srcDir, targetDir, exclude);

  const deployedIdentityPath = path.join(targetDir, 'build-identity.json');
  const deployedIdentity = JSON.parse(fs.readFileSync(deployedIdentityPath, 'utf8'));

  console.log(`Deployment SUCCESSFUL!`);
  console.log(`Target: ${targetDir}`);
  console.log(`Installed Build Identity:`, JSON.stringify(deployedIdentity, null, 2));

  if (deployedIdentity.buildNumber !== 159) {
    throw new Error(`Expected buildNumber 159 but got ${deployedIdentity.buildNumber}`);
  }
}

main().catch((err) => {
  console.error('Deployment FAILED:', err);
  process.exit(1);
});
