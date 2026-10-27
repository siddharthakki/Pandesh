// Stand-in for pocket-tts.exe: GET /health, POST /tts streaming a placeholder-size WAV in chunks.
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.argv[2]);
const crashOnce = process.argv[3]; // marker file: first "CRASH" request exits mid-stream
if (process.argv[4] === 'fail-start') { console.error('boom: cannot load model'); process.exit(3); }

function header() {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(2000000036, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(2000000000, 40);
  return h;
}

http.createServer((req, res) => {
  if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end('{"status":"healthy"}'); return; }
  if (req.url !== '/tts' || req.method !== 'POST') { res.statusCode = 404; res.end(); return; }
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    const body = Buffer.concat(parts).toString('latin1');
    res.setHeader('content-type', 'audio/wav');
    res.write(header());
    res.write(Buffer.alloc(4800));
    if (body.includes('CRASH') && crashOnce && !fs.existsSync(crashOnce)) {
      fs.writeFileSync(crashOnce, '1');
      setTimeout(() => process.exit(1), 20);
      return;
    }
    const slow = body.includes('SLOW');
    let n = 0;
    const timer = setInterval(() => {
      res.write(Buffer.alloc(4800));
      if (++n >= (slow ? 100 : 3)) { clearInterval(timer); res.end(); }
    }, slow ? 50 : 5);
    res.on('close', () => clearInterval(timer));
  });
}).listen(port, '127.0.0.1');
