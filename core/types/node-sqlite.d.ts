/**
 * Minimal ambient typings for `node:sqlite`, since the installed
 * `@types/node` version predates its inclusion. Only the surface actually
 * used by the Core is declared here; extend as needed.
 */
declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: unknown[]): StatementResultingChanges;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
    setAllowBareNamedParameters(enabled: boolean): void;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    timeout?: number;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    open(): void;
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    isOpen: boolean;
    function(name: string, fn: (...args: unknown[]) => unknown): void;
  }
}
