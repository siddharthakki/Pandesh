/** What a Workshop viewer reports back for a command: only `ok` lets Core say it happened. */
export interface CommandOutcome { ok: boolean; detail?: string; state?: Record<string, unknown> }

/** The imperative side of a viewer, so Core's view commands reach the thing on screen. */
export interface ViewerHandle {
  run(action: string, args: Record<string, unknown>): Promise<CommandOutcome>;
  inspect(): Record<string, unknown> | null;
}

/** What the Workshop shows in a conversation, remembered across restarts. */
export interface WorkshopUi { workshopId: string | null; artifactId: string | null; mode: 'side' | 'full' }
