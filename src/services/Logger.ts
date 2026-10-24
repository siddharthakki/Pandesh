export class Logger {
  static error(message: string, ...args: unknown[]): void {
    console.error(`[ollama-agent] ${message}`, ...args);
  }

  static warn(message: string, ...args: unknown[]): void {
    console.warn(`[ollama-agent] ${message}`, ...args);
  }

  static info(message: string, ...args: unknown[]): void {
    console.log(`[ollama-agent] ${message}`, ...args);
  }
}
