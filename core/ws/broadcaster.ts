import { EventEmitter } from 'node:events';
import type { StoryEventRecord, RuntimeEventRecord, RuntimeTokenFrame } from '../shared/wireTypes';

/**
 * In-process fan-out from "a mutation just committed" to "push it to
 * connected WS clients." This is intentionally NOT the cross-client sync
 * mechanism itself (that's the real WebSocket server broadcasting to real
 * remote connections) — it's just the internal wiring between the API
 * route handlers and the WS server within a single Core process.
 *
 * `publishRuntime` is the M32 addition for conversation/request/attempt/
 * invocation/approval events — a second, independently-sequenced channel,
 * additive alongside `publish` (story events). See docs/m32-decisions.md D3.
 */
export class EventBroadcaster extends EventEmitter {
  publish(event: StoryEventRecord): void {
    this.emit('story_event', event);
  }

  publishRuntime(event: RuntimeEventRecord): void {
    this.emit('runtime_event', event);
  }

  /**
   * Ephemeral live token delta for an in-flight model call (M32 Core-owned
   * execution). Unlike `publishRuntime`, this is NOT persisted or sequenced —
   * it is best-effort live UX; the durable assistant message and
   * model_invocation rows are the source of truth. A client that misses tokens
   * recovers the full text from the appended conversation message.
   */
  publishRuntimeToken(frame: RuntimeTokenFrame): void {
    this.emit('runtime_token', frame);
  }
}

export type { RuntimeTokenFrame };
