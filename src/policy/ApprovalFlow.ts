import { TaskStoreWriteBarrier } from '../services/TaskStoreWriteBarrier';

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  riskLevel: string;
}

export type ApprovalResponse = 'approved' | 'rejected';

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (response: ApprovalResponse) => void;
  reject: (err: Error) => void;
};

export class ApprovalFlow {
  private pending = new Map<string, PendingApproval>();
  private onRequestCallback?: (req: ApprovalRequest) => void;

  /**
   * Called before an approval is shown. If it returns a promise, the request is
   * withheld until the pending approval has been durably persisted.
   */
  onApprovalRequested?: (
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    riskLevel: string,
  ) => void | Promise<void>;

  /**
   * Called when an approval is resolved. If it returns a promise, the blocked
   * tool promise is released only after that durable update finishes.
   */
  onApprovalResolved?: (
    id: string,
    resolution: ApprovalResponse,
  ) => void | Promise<void>;

  setOnRequest(cb: (req: ApprovalRequest) => void): void {
    this.onRequestCallback = cb;
  }

  async requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    reason: string,
    riskLevel: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ApprovalResponse> {
    const id = `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const request: ApprovalRequest = { id, toolName, args, reason, riskLevel };

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<ApprovalResponse>((resolve, reject) => {
      this.pending.set(id, { request, resolve, reject });

      const cleanup = () => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      };

      signal?.addEventListener('abort', () => {
        if (this.pending.has(id)) {
          cleanup();
          this.pending.delete(id);
          reject(new Error('Agent stopped — approval cancelled.'));
        }
      });

      if (timeoutMs && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`Approval timed out after ${timeoutMs}ms.`));
          }
        }, timeoutMs);
      }
    });

    try {
      await this.onApprovalRequested?.(id, toolName, args, riskLevel);
      await TaskStoreWriteBarrier.drain();
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
      return promise;
    }

    // The approval exists in memory and in durable state before the UI sees it.
    this.onRequestCallback?.(request);
    return promise;
  }

  respond(id: string, response: ApprovalResponse): boolean {
    console.log(`[OllamaAgent] ApprovalFlow.respond called: id=${id} response=${response} pendingCount=${this.pending.size} knownIds=[${[...this.pending.keys()].join(',')}]`);
    const pending = this.pending.get(id);
    if (!pending) {
      console.error(`[OllamaAgent] ApprovalFlow.respond: no pending approval found for id=${id}`);
      return false;
    }

    this.pending.delete(id);
    Promise.resolve(this.onApprovalResolved?.(id, response))
      .then(() => TaskStoreWriteBarrier.drain())
      .then(() => {
        console.log(`[OllamaAgent] ApprovalFlow.respond: resolved id=${id} with ${response}`);
        pending.resolve(response);
      })
      .catch(error => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    return true;
  }

  cancelAll(): void {
    for (const [, pending] of this.pending) {
      pending.reject(new Error('Agent stopped — all pending approvals cancelled.'));
    }
    this.pending.clear();
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}
