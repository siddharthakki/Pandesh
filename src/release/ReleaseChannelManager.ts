import { createHash, randomUUID } from 'crypto';

export type ReleaseChannel = 'development' | 'beta' | 'stable';
export type ReleaseStatus = 'draft' | 'staged' | 'active' | 'rolled-back' | 'revoked';

export interface ReleaseArtifactFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ReleaseMigration {
  id: string;
  fromSchema: number;
  toSchema: number;
  reversible: boolean;
}

export interface ReleaseManifest {
  releaseId: string;
  version: string;
  channel: ReleaseChannel;
  commit: string;
  createdAt: string;
  files: ReleaseArtifactFile[];
  sbomFingerprint: string;
  buildFingerprint: string;
  migrations: ReleaseMigration[];
  minimumCompatibleVersion?: string;
  signature?: string;
  signer?: string;
}

export interface ReleaseRecord {
  manifest: ReleaseManifest;
  status: ReleaseStatus;
  rolloutPercent: number;
  activatedAt?: string;
  rolledBackAt?: string;
  rollbackTarget?: string;
}

export interface ReleaseSigner {
  sign(payload: string): Promise<{ signature: string; signer: string }>;
  verify(payload: string, signature: string, signer: string): Promise<boolean>;
}

export interface BuildProvenanceInput {
  version: string;
  channel: ReleaseChannel;
  commit: string;
  files: ReleaseArtifactFile[];
  sbomFingerprint: string;
  buildInputs: Record<string, string>;
  migrations?: ReleaseMigration[];
  minimumCompatibleVersion?: string;
}

export class ReleaseChannelManager {
  private readonly releases = new Map<string, ReleaseRecord>();
  private readonly activeByChannel = new Map<ReleaseChannel, string>();

  constructor(private readonly signer: ReleaseSigner) {}

  async create(input: BuildProvenanceInput): Promise<ReleaseRecord> {
    validateInput(input);
    const files = normalizeFiles(input.files);
    const buildFingerprint = createHash('sha256')
      .update(stableStringify({
        commit: input.commit,
        files,
        sbomFingerprint: input.sbomFingerprint,
        buildInputs: input.buildInputs,
      }))
      .digest('hex');
    return this.signAndStore({
      releaseId: randomUUID(),
      version: input.version,
      channel: input.channel,
      commit: input.commit,
      createdAt: new Date().toISOString(),
      files,
      sbomFingerprint: input.sbomFingerprint,
      buildFingerprint,
      migrations: [...(input.migrations ?? [])].map(migration => ({ ...migration })),
      minimumCompatibleVersion: input.minimumCompatibleVersion,
    });
  }

  async verify(releaseId: string): Promise<boolean> {
    const record = this.require(releaseId);
    const { signature, signer } = record.manifest;
    if (!signature || !signer) return false;
    return this.signer.verify(manifestPayload(record.manifest), signature, signer);
  }

  async stage(releaseId: string, rolloutPercent: number): Promise<ReleaseRecord> {
    const record = this.require(releaseId);
    if (!await this.verify(releaseId)) throw new Error('Release signature verification failed.');
    if (record.status === 'revoked' || record.status === 'rolled-back') {
      throw new Error(`Cannot stage release in status ${record.status}.`);
    }
    validateRollout(rolloutPercent);
    record.status = rolloutPercent === 100 ? 'active' : 'staged';
    record.rolloutPercent = rolloutPercent;
    if (rolloutPercent === 100) {
      const previous = this.activeByChannel.get(record.manifest.channel);
      if (previous && previous !== releaseId) {
        const priorRecord = this.releases.get(previous);
        if (priorRecord?.status === 'active') priorRecord.status = 'staged';
      }
      record.activatedAt = new Date().toISOString();
      this.activeByChannel.set(record.manifest.channel, releaseId);
    }
    return clone(record);
  }

  async promote(releaseId: string, targetChannel: ReleaseChannel): Promise<ReleaseRecord> {
    const source = this.require(releaseId);
    if (source.status !== 'active') throw new Error('Only an active release can be promoted.');
    if (!await this.verify(releaseId)) throw new Error('Release signature verification failed.');
    if (source.manifest.channel === targetChannel) {
      throw new Error(`Release is already in channel ${targetChannel}.`);
    }

    const promoted = await this.signAndStore({
      releaseId: randomUUID(),
      version: source.manifest.version,
      channel: targetChannel,
      commit: source.manifest.commit,
      createdAt: new Date().toISOString(),
      files: source.manifest.files.map(file => ({ ...file })),
      sbomFingerprint: source.manifest.sbomFingerprint,
      buildFingerprint: source.manifest.buildFingerprint,
      migrations: source.manifest.migrations.map(migration => ({ ...migration })),
      minimumCompatibleVersion: source.manifest.minimumCompatibleVersion,
    });
    if (promoted.manifest.buildFingerprint !== source.manifest.buildFingerprint) {
      throw new Error('Promotion changed the reproducible build fingerprint.');
    }
    return promoted;
  }

  async rollback(channel: ReleaseChannel, targetReleaseId: string): Promise<ReleaseRecord> {
    const currentId = this.activeByChannel.get(channel);
    if (!currentId) throw new Error(`No active release exists for ${channel}.`);
    const current = this.require(currentId);
    const target = this.require(targetReleaseId);
    if (target.manifest.channel !== channel) throw new Error('Rollback target belongs to a different channel.');
    if (!await this.verify(targetReleaseId)) throw new Error('Rollback target signature verification failed.');
    assertRollbackCompatible(current.manifest, target.manifest);
    current.status = 'rolled-back';
    current.rolledBackAt = new Date().toISOString();
    current.rollbackTarget = targetReleaseId;
    target.status = 'active';
    target.rolloutPercent = 100;
    target.activatedAt = new Date().toISOString();
    this.activeByChannel.set(channel, targetReleaseId);
    return clone(target);
  }

  revoke(releaseId: string): ReleaseRecord {
    const record = this.require(releaseId);
    if (this.activeByChannel.get(record.manifest.channel) === releaseId) {
      throw new Error('Active release must be rolled back before revocation.');
    }
    record.status = 'revoked';
    record.rolloutPercent = 0;
    return clone(record);
  }

  active(channel: ReleaseChannel): ReleaseRecord | undefined {
    const id = this.activeByChannel.get(channel);
    return id ? clone(this.require(id)) : undefined;
  }

  list(channel?: ReleaseChannel): ReleaseRecord[] {
    return [...this.releases.values()]
      .filter(record => !channel || record.manifest.channel === channel)
      .map(clone)
      .sort((left, right) => left.manifest.createdAt.localeCompare(right.manifest.createdAt));
  }

  private async signAndStore(manifest: ReleaseManifest): Promise<ReleaseRecord> {
    const signed = await this.signer.sign(manifestPayload(manifest));
    manifest.signature = signed.signature;
    manifest.signer = signed.signer;
    const record: ReleaseRecord = {
      manifest,
      status: 'draft',
      rolloutPercent: 0,
    };
    this.releases.set(manifest.releaseId, record);
    return clone(record);
  }

  private require(id: string): ReleaseRecord {
    const record = this.releases.get(id);
    if (!record) throw new Error(`Unknown release: ${id}`);
    return record;
  }
}

function manifestPayload(manifest: ReleaseManifest): string {
  const copy = { ...manifest, signature: undefined, signer: undefined };
  return stableStringify(copy);
}

function normalizeFiles(files: ReleaseArtifactFile[]): ReleaseArtifactFile[] {
  return [...files]
    .map(file => ({ ...file, path: normalizePath(file.path) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function assertRollbackCompatible(current: ReleaseManifest, target: ReleaseManifest): void {
  const irreversible = current.migrations.filter(migration =>
    migration.toSchema > maxSchema(target.migrations) && !migration.reversible,
  );
  if (irreversible.length > 0) {
    throw new Error(`Rollback blocked by irreversible migrations: ${irreversible.map(item => item.id).join(', ')}`);
  }
}

function maxSchema(migrations: ReleaseMigration[]): number {
  return migrations.reduce((value, migration) => Math.max(value, migration.toSchema), 0);
}

function validateInput(input: BuildProvenanceInput): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) throw new Error('Release version is invalid.');
  if (!/^[a-f0-9]{7,64}$/i.test(input.commit)) throw new Error('Release commit is invalid.');
  if (!/^[a-f0-9]{64}$/i.test(input.sbomFingerprint)) throw new Error('SBOM fingerprint is invalid.');
  if (input.files.length === 0) throw new Error('Release requires at least one artifact file.');
  for (const file of input.files) {
    normalizePath(file.path);
    if (!/^[a-f0-9]{64}$/i.test(file.sha256) || file.sizeBytes < 0) throw new Error(`Invalid release file: ${file.path}`);
  }
}

function validateRollout(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Rollout percentage must be between 1 and 100.');
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Invalid release artifact path: ${value}`);
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
