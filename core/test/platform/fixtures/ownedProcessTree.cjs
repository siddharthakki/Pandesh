const fs = require('node:fs');
const { spawn } = require('node:child_process');

const pidFile = process.argv[2];
if (process.argv[3] === 'grandchild') {
  setInterval(() => {}, 1_000);
} else {
  const grandchild = spawn(process.execPath, [__filename, pidFile, 'grandchild'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  fs.writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  setInterval(() => {}, 1_000);
}
