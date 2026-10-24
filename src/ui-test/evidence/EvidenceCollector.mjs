import fs from 'node:fs';
import path from 'node:path';

export class EvidenceCollector {
  constructor(driver, evidenceDir) {
    this.driver = driver;
    this.evidenceDir = evidenceDir;
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  async screenshot(name) {
    const data = await this.driver.takeScreenshot();
    fs.writeFileSync(path.join(this.evidenceDir, `${name}.png`), data, 'base64');
  }

  json(name, value) {
    fs.writeFileSync(path.join(this.evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  text(name, value) {
    fs.writeFileSync(path.join(this.evidenceDir, name), String(value), 'utf8');
  }
}
