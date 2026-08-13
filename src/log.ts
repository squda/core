/**
 * Phase 3, step 6 — logs you can search.
 *
 * JSON lines, because the consumer is a log aggregator rather than a person
 * squinting at a terminal, and because the moment there are two requests in
 * flight, prose interleaves into nonsense.
 *
 * Every line carries the fields of the logger that wrote it, so a child logger
 * created per request stamps its id on everything downstream without a single
 * function having to pass it along.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  level?: LogLevel;
  /** Where a line goes. Injectable so tests can read what was written. */
  write?: (line: string) => void;
  now?: () => Date;
}

export class Logger {
  readonly #fields: LogFields;
  readonly #level: LogLevel;
  readonly #write: (line: string) => void;
  readonly #now: () => Date;

  constructor(fields: LogFields = {}, options: LoggerOptions = {}) {
    this.#fields = fields;
    this.#level = options.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info';
    this.#write = options.write ?? ((line) => process.stdout.write(line + '\n'));
    this.#now = options.now ?? (() => new Date());
  }

  /** A logger that carries these fields on every line, plus the parent's. */
  child(fields: LogFields): Logger {
    return new Logger(
      { ...this.#fields, ...fields },
      { level: this.#level, write: this.#write, now: this.#now },
    );
  }

  debug = (message: string, fields?: LogFields) => this.#log('debug', message, fields);
  info = (message: string, fields?: LogFields) => this.#log('info', message, fields);
  warn = (message: string, fields?: LogFields) => this.#log('warn', message, fields);
  error = (message: string, fields?: LogFields) => this.#log('error', message, fields);

  #log(level: LogLevel, message: string, fields?: LogFields): void {
    if (ORDER[level] < ORDER[this.#level]) return;

    this.#write(
      JSON.stringify({
        at: this.#now().toISOString(),
        level,
        message,
        ...this.#fields,
        ...fields,
      }),
    );
  }
}

/** Discards everything. The default for a library that shouldn't print. */
export const silentLogger = new Logger({}, { level: 'error', write: () => {} });
