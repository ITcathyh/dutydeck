export class DatabaseCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DatabaseCliError';
  }
}
