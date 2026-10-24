import { randomUUID } from 'crypto';

export type RemoteDeviceStatus = 'online' | 'offline' | 'disabled';
export type RemoteMessageKind = 'task' | 'event' | 'result' | 'approval' | 'cancel' | 'heartbeat';

export interface RemoteDevice {
  id: string;
  name: string;
  publicKeyFingerprint: string;
  capabilities: string[];
  labels: Record<string, string>;
  privacy: 'local' | 'private' | 'public';
  maxConcurrent: number;
  activeTasks: number;
  status: RemoteDeviceStatus;
  registeredAt: string;
  lastSeenAt: string;
}

export interface RemoteMessage {
  id: string;
  streamId: string;
  sequence: number;
  kind: RemoteMessageKind;
  sourceDeviceId: string;
  targetDeviceId?: string;
  taskId?: string;
  idempotencyKey?: string;
  createdAt: string;
  acknowledgedAt?: string;
  payload: Record<string, unknown>;
}

export interface RemoteTaskRequest {
  taskId: string;
  requiredCapabilities: string[];
  requiredLabels?: Record<string, string>;
  privacy: RemoteDevice['privacy'];
  preferredDeviceId?: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface PlacementDecision {
  deviceId: string;
  score: number;
  reasons: string[];
}

export interface RemoteTaskStorage {
  loadDevices(): Promise<RemoteDevice[]>;
  loadMessages(): Promise<RemoteMessage[]>;
  saveDevices(devices: RemoteDevice[]): Promise<void>;
  saveMessages(messages: RemoteMessage[]): Promise<void>;
}

export class InMemoryRemoteTaskStorage implements RemoteTaskStorage {
  private devices: RemoteDevice[] = [];
  private messages: RemoteMessage[] = [];

  async loadDevices(): Promise<RemoteDevice[]> { return clone(this.devices); }
  async loadMessages(): Promise<RemoteMessage[]> { return clone(this.messages); }
  async saveDevices(devices: RemoteDevice[]): Promise<void> { this.devices = clone(devices); }
  async saveMessages(messages: RemoteMessage[]): Promise<void> { this.messages = clone(messages); }
}

export class RemoteTaskService {
  private readonly devices = new Map<string, RemoteDevice>();
  private readonly messages: RemoteMessage[] = [];
  private readonly mutationKeys = new Map<string, string>();
  private sequence = 0;

  constructor(private readonly storage: RemoteTaskStorage) {}

  async initialize(): Promise<void> {
    this.devices.clear();
    this.messages.length = 0;
    this.mutationKeys.clear();
    for (const device of await this.storage.loadDevices()) {
      validateDevice(device);
      this.devices.set(device.id, clone(device));
    }
    for (const message of await this.storage.loadMessages()) {
      validateMessage(message);
      this.messages.push(clone(message));
      this.sequence = Math.max(this.sequence, message.sequence);
      if (message.idempotencyKey) this.mutationKeys.set(message.idempotencyKey, message.id);
    }
  }

  async registerDevice(input: Omit<RemoteDevice, 'registeredAt' | 'lastSeenAt' | 'activeTasks'>): Promise<RemoteDevice> {
    validateDevice({
      ...input,
      registeredAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      activeTasks: 0,
    });
    const existing = this.devices.get(input.id);
    if (existing && existing.publicKeyFingerprint !== input.publicKeyFingerprint) {
      throw new Error(`Device fingerprint changed for ${input.id}.`);
    }
    const now = new Date().toISOString();
    const device: RemoteDevice = {
      ...clone(input),
      activeTasks: existing?.activeTasks ?? 0,
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
    };
    this.devices.set(device.id, device);
    await this.persistDevices();
    return clone(device);
  }

  async heartbeat(deviceId: string): Promise<RemoteDevice> {
    const device = this.requireDevice(deviceId);
    device.lastSeenAt = new Date().toISOString();
    if (device.status !== 'disabled') device.status = 'online';
    await this.persistDevices();
    return clone(device);
  }

  place(request: RemoteTaskRequest): PlacementDecision {
    validateRequest(request);
    const candidates = [...this.devices.values()]
      .filter(device => device.status === 'online')
      .filter(device => device.activeTasks < device.maxConcurrent)
      .filter(device => request.requiredCapabilities.every(capability => device.capabilities.includes(capability)))
      .filter(device => labelsMatch(request.requiredLabels ?? {}, device.labels))
      .filter(device => privacyAllowed(request.privacy, device.privacy))
      .map(device => {
        let score = 100 - device.activeTasks / device.maxConcurrent * 40;
        const reasons = [`capacity=${device.activeTasks}/${device.maxConcurrent}`];
        if (device.id === request.preferredDeviceId) { score += 30; reasons.push('preferred device'); }
        if (device.privacy === 'local') { score += 10; reasons.push('local privacy'); }
        score += request.requiredCapabilities.length;
        return { deviceId: device.id, score, reasons };
      })
      .sort((left, right) => right.score - left.score || left.deviceId.localeCompare(right.deviceId));
    if (candidates.length === 0) throw new Error(`No remote device satisfies task ${request.taskId}.`);
    return candidates[0];
  }

  async submit(request: RemoteTaskRequest, sourceDeviceId: string): Promise<RemoteMessage> {
    this.requireDevice(sourceDeviceId);
    const existingId = this.mutationKeys.get(request.idempotencyKey);
    if (existingId) {
      const existing = this.messages.find(message => message.id === existingId);
      if (!existing || stableStringify(existing.payload) !== stableStringify(request.payload)) {
        throw new Error('Remote idempotency key is bound to a different request.');
      }
      return clone(existing);
    }
    const placement = this.place(request);
    const target = this.requireDevice(placement.deviceId);
    const message = this.createMessage({
      streamId: request.taskId,
      kind: 'task',
      sourceDeviceId,
      targetDeviceId: placement.deviceId,
      taskId: request.taskId,
      idempotencyKey: request.idempotencyKey,
      payload: clone(request.payload),
    });
    target.activeTasks += 1;
    this.mutationKeys.set(request.idempotencyKey, message.id);
    await Promise.all([this.persistDevices(), this.persistMessages()]);
    return clone(message);
  }

  async append(input: Omit<RemoteMessage, 'id' | 'sequence' | 'createdAt'>): Promise<RemoteMessage> {
    this.requireDevice(input.sourceDeviceId);
    if (input.targetDeviceId) this.requireDevice(input.targetDeviceId);
    const message = this.createMessage(input);
    await this.persistMessages();
    return clone(message);
  }

  async acknowledge(messageId: string, deviceId: string): Promise<RemoteMessage> {
    this.requireDevice(deviceId);
    const message = this.messages.find(item => item.id === messageId);
    if (!message) throw new Error(`Unknown remote message: ${messageId}`);
    if (message.targetDeviceId && message.targetDeviceId !== deviceId) {
      throw new Error(`Device ${deviceId} cannot acknowledge message ${messageId}.`);
    }
    message.acknowledgedAt = new Date().toISOString();
    if ((message.kind === 'result' || message.kind === 'cancel') && message.taskId) {
      const taskMessage = this.messages.find(item => item.kind === 'task' && item.taskId === message.taskId);
      if (taskMessage?.targetDeviceId) {
        const target = this.devices.get(taskMessage.targetDeviceId);
        if (target) target.activeTasks = Math.max(0, target.activeTasks - 1);
      }
    }
    await Promise.all([this.persistDevices(), this.persistMessages()]);
    return clone(message);
  }

  resume(streamId: string, afterSequence = 0, deviceId?: string): RemoteMessage[] {
    if (deviceId) this.requireDevice(deviceId);
    return this.messages
      .filter(message => message.streamId === streamId && message.sequence > afterSequence)
      .filter(message => !deviceId || message.sourceDeviceId === deviceId || message.targetDeviceId === deviceId)
      .map(clone)
      .sort((left, right) => left.sequence - right.sequence);
  }

  pendingFor(deviceId: string): RemoteMessage[] {
    this.requireDevice(deviceId);
    return this.messages
      .filter(message => message.targetDeviceId === deviceId && !message.acknowledgedAt)
      .map(clone)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async disableDevice(deviceId: string): Promise<RemoteDevice> {
    const device = this.requireDevice(deviceId);
    device.status = 'disabled';
    await this.persistDevices();
    return clone(device);
  }

  snapshot(): { devices: RemoteDevice[]; messages: RemoteMessage[] } {
    return {
      devices: [...this.devices.values()].map(clone).sort((left, right) => left.id.localeCompare(right.id)),
      messages: this.messages.map(clone).sort((left, right) => left.sequence - right.sequence),
    };
  }

  private createMessage(input: Omit<RemoteMessage, 'id' | 'sequence' | 'createdAt'>): RemoteMessage {
    const message: RemoteMessage = {
      ...clone(input),
      id: randomUUID(),
      sequence: ++this.sequence,
      createdAt: new Date().toISOString(),
    };
    validateMessage(message);
    this.messages.push(message);
    return message;
  }

  private requireDevice(id: string): RemoteDevice {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Unknown remote device: ${id}`);
    return device;
  }

  private persistDevices(): Promise<void> {
    return this.storage.saveDevices([...this.devices.values()].map(clone));
  }

  private persistMessages(): Promise<void> {
    return this.storage.saveMessages(this.messages.map(clone));
  }
}

function validateDevice(device: RemoteDevice): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(device.id)) throw new Error(`Invalid remote device id: ${device.id}`);
  if (!/^[a-f0-9:]{16,200}$/i.test(device.publicKeyFingerprint)) throw new Error(`Invalid device fingerprint: ${device.id}`);
  if (!Number.isInteger(device.maxConcurrent) || device.maxConcurrent < 1) throw new Error(`Invalid device concurrency: ${device.id}`);
  if (!Number.isInteger(device.activeTasks) || device.activeTasks < 0 || device.activeTasks > device.maxConcurrent) throw new Error(`Invalid active task count: ${device.id}`);
}

function validateMessage(message: RemoteMessage): void {
  if (!Number.isInteger(message.sequence) || message.sequence < 1) throw new Error(`Invalid remote sequence: ${message.sequence}`);
  if (!message.streamId.trim()) throw new Error('Remote stream id is required.');
}

function validateRequest(request: RemoteTaskRequest): void {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(request.taskId)) throw new Error(`Invalid remote task id: ${request.taskId}`);
  if (!/^[a-zA-Z0-9._:-]{1,240}$/.test(request.idempotencyKey)) throw new Error('Invalid remote idempotency key.');
}

function labelsMatch(required: Record<string, string>, actual: Record<string, string>): boolean {
  return Object.entries(required).every(([key, value]) => actual[key] === value);
}

function privacyAllowed(required: RemoteDevice['privacy'], offered: RemoteDevice['privacy']): boolean {
  const rank = { local: 0, private: 1, public: 2 } as const;
  return rank[offered] <= rank[required];
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
