export type CoreConnectionState =
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'incompatible'
  | 'authentication_failed'
  | 'database_failed'
  | 'unavailable';

export interface CoreConnectionStatus {
  state: CoreConnectionState;
  /**
   * A plain-language sentence for the operator.
   *
   * It never contains an internal counter, a backoff millisecond figure, or
   * any other machine detail: this text is shown in a banner, and a banner
   * that says "attempt 31, retrying in 30000ms" tells the person nothing they
   * can act on.
   */
  detail?: string;
  coreVersion?: string;
  apiVersion?: number;
}
