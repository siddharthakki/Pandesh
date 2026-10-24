import { HookEvent, HookContext, HookFn } from './HookTypes';

export class HookEngine {
  private hooks = new Map<HookEvent, HookFn[]>();

  register(event: HookEvent, fn: HookFn): void {
    const existing = this.hooks.get(event) ?? [];
    this.hooks.set(event, [...existing, fn]);
  }

  async emit(ctx: HookContext): Promise<void> {
    const fns = this.hooks.get(ctx.event) ?? [];
    for (const fn of fns) {
      try {
        await fn(ctx);
      } catch {
        // Hook errors must not crash the agent loop
      }
    }
  }
}
