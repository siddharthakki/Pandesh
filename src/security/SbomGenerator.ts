import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export interface SbomComponent {
  type: 'application' | 'library';
  name: string;
  version: string;
  packageUrl?: string;
  licenses: string[];
  development: boolean;
}

export interface SoftwareBillOfMaterials {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  serialNumber: string;
  version: 1;
  metadata: {
    timestamp: string;
    component: SbomComponent;
  };
  components: SbomComponent[];
  fingerprint: string;
}

interface PackageManifest {
  name?: string;
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<string, {
    name?: string;
    version?: string;
    license?: string;
    dev?: boolean;
  }>;
}

export class SbomGenerator {
  constructor(private readonly workspaceRoot: string) {}

  async generate(): Promise<SoftwareBillOfMaterials> {
    const manifest = JSON.parse(
      await fs.readFile(path.join(this.workspaceRoot, 'package.json'), 'utf8'),
    ) as PackageManifest;
    const lock = await this.readLock();
    const application: SbomComponent = {
      type: 'application',
      name: manifest.name ?? path.basename(this.workspaceRoot),
      version: manifest.version ?? '0.0.0',
      licenses: manifest.license ? [manifest.license] : [],
      development: false,
    };
    const components = lock
      ? componentsFromLock(lock)
      : componentsFromManifest(manifest);
    const material = JSON.stringify({ application, components });
    const fingerprint = createHash('sha256').update(material).digest('hex');
    return {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      serialNumber: `urn:uuid:${formatUuid(fingerprint)}`,
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        component: application,
      },
      components,
      fingerprint,
    };
  }

  async write(filename: string): Promise<SoftwareBillOfMaterials> {
    const report = await this.generate();
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filename);
    return report;
  }

  private async readLock(): Promise<PackageLock | undefined> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.workspaceRoot, 'package-lock.json'), 'utf8'),
      ) as PackageLock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

function componentsFromLock(lock: PackageLock): SbomComponent[] {
  return Object.entries(lock.packages ?? {})
    .filter(([key, value]) => key.startsWith('node_modules/') && Boolean(value.version))
    .map(([key, value]) => {
      const name = value.name ?? key.slice('node_modules/'.length);
      const version = value.version ?? '0.0.0';
      return {
        type: 'library' as const,
        name,
        version,
        packageUrl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
        licenses: value.license ? [value.license] : [],
        development: Boolean(value.dev),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function componentsFromManifest(manifest: PackageManifest): SbomComponent[] {
  const output: SbomComponent[] = [];
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    output.push(component(name, version, false));
  }
  for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
    output.push(component(name, version, true));
  }
  return output.sort((left, right) => left.name.localeCompare(right.name));
}

function component(name: string, version: string, development: boolean): SbomComponent {
  const cleanVersion = version.replace(/^[~^<>=\s]+/, '');
  return {
    type: 'library',
    name,
    version: cleanVersion,
    packageUrl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(cleanVersion)}`,
    licenses: [],
    development,
  };
}

function formatUuid(hash: string): string {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
