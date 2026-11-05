import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import sqlite3 from '@vscode/sqlite3';

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toUpperCase();
}

function copyRecursive(src, dest, stats = { files: 0, bytes: 0 }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry), stats);
    }
    return stats;
  }
  fs.copyFileSync(src, dest);
  stats.files += 1;
  stats.bytes += stat.size;
  return stats;
}

async function verifyDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      db.get('PRAGMA integrity_check;', (err, row) => {
        if (err) { db.close(); return reject(err); }
        db.get('SELECT COUNT(*) as convCount FROM conversations;', (err, convRow) => {
          if (err) { db.close(); return reject(err); }
          db.get('SELECT COUNT(*) as artCount FROM artifacts;', (err, artRow) => {
            db.close();
            if (err) return reject(err);
            resolve({
              integrity: row.integrity_check,
              conversations: convRow.convCount,
              artifacts: artRow.artCount,
            });
          });
        });
      });
    });
  });
}

async function main() {
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const installSrc = 'E:\\Pandesh';
  const dataSrc = path.join(process.env.LOCALAPPDATA, 'KarkeDikha', 'desktop');

  const backupDirE = path.join('E:\\Pandesh-Backups', `backup-before-b156-${timestamp}`);
  const installBackupDst = path.join(backupDirE, 'install-b155');
  const dataBackupDstE = path.join(backupDirE, 'desktop-userdata');
  const dataBackupDstLocal = path.join(process.env.LOCALAPPDATA, 'KarkeDikha', `desktop-backup-before-build156-${timestamp}`);

  console.log('1. Verifying source paths exist...');
  if (!fs.existsSync(installSrc)) throw new Error(`Install dir missing: ${installSrc}`);
  if (!fs.existsSync(dataSrc)) throw new Error(`User data dir missing: ${dataSrc}`);

  console.log('2. Backing up production install directory to E:...');
  fs.mkdirSync(installBackupDst, { recursive: true });
  const installStats = copyRecursive(installSrc, installBackupDst);
  console.log(`   Copied ${installStats.files} install files (${(installStats.bytes / (1024*1024)).toFixed(2)} MB)`);

  console.log('3. Backing up desktop user data to E:...');
  fs.mkdirSync(dataBackupDstE, { recursive: true });
  const dataStatsE = copyRecursive(dataSrc, dataBackupDstE);
  console.log(`   Copied ${dataStatsE.files} userdata files to E: (${(dataStatsE.bytes / (1024*1024)).toFixed(2)} MB)`);

  console.log('4. Backing up desktop user data locally in LocalAppData...');
  fs.mkdirSync(dataBackupDstLocal, { recursive: true });
  const dataStatsLocal = copyRecursive(dataSrc, dataBackupDstLocal);
  console.log(`   Copied ${dataStatsLocal.files} userdata files to LocalAppData (${(dataStatsLocal.bytes / (1024*1024)).toFixed(2)} MB)`);

  console.log('5. Verifying database consistency of backups...');
  const dbSrc = path.join(dataSrc, 'core.db');
  const dbBackupE = path.join(dataBackupDstE, 'core.db');
  const dbBackupLocal = path.join(dataBackupDstLocal, 'core.db');

  const srcDbCheck = await verifyDb(dbSrc);
  console.log('   Source DB check:', srcDbCheck);
  const backupEDbCheck = await verifyDb(dbBackupE);
  console.log('   Backup E: DB check:', backupEDbCheck);
  const backupLocalDbCheck = await verifyDb(dbBackupLocal);
  console.log('   Backup LocalAppData DB check:', backupLocalDbCheck);

  if (srcDbCheck.integrity !== 'ok' || backupEDbCheck.integrity !== 'ok' || backupLocalDbCheck.integrity !== 'ok') {
    throw new Error('Database integrity check failed!');
  }

  console.log('6. Verifying key file hashes...');
  const keyFiles = ['core.db', 'cloud-providers.json', 'selected-model.json', 'selected-conversation.json', 'window-state.json'];
  const hashVerifications = {};
  for (const kf of keyFiles) {
    const s = path.join(dataSrc, kf);
    if (fs.existsSync(s)) {
      const srcHash = sha256(s);
      const eHash = sha256(path.join(dataBackupDstE, kf));
      const locHash = sha256(path.join(dataBackupDstLocal, kf));
      hashVerifications[kf] = {
        srcSha256: srcHash,
        eBackupMatch: srcHash === eHash,
        localBackupMatch: srcHash === locHash,
      };
      if (srcHash !== eHash || srcHash !== locHash) {
        throw new Error(`Hash mismatch for ${kf}`);
      }
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    timestamp,
    installSrc,
    dataSrc,
    installBackupDst,
    dataBackupDstE,
    dataBackupDstLocal,
    installStats,
    dataStatsE,
    dataStatsLocal,
    dbCheck: {
      source: srcDbCheck,
      backupE: backupEDbCheck,
      backupLocal: backupLocalDbCheck,
    },
    keyFileVerifications: hashVerifications,
    installedIdentityBefore: JSON.parse(fs.readFileSync(path.join(installSrc, 'build-identity.json'), 'utf8')),
  };

  const manifestPathE = path.join(backupDirE, 'backup-manifest.json');
  fs.writeFileSync(manifestPathE, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dataBackupDstLocal, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\nBackup SUCCESSFUL and verified! Manifest written to ${manifestPathE}`);
}

main().catch((err) => {
  console.error('Backup failed:', err);
  process.exit(1);
});

