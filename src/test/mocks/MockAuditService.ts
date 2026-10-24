import type { AuditEvent } from '../../services/AuditService';

export class MockAuditService {
  events: AuditEvent[] = [];

  log(event: AuditEvent): void {
    this.events.push(event);
  }

  reset(): void {
    this.events = [];
  }
}
