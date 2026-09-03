import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly assetId?: string;
  readonly chainId?: number;
  readonly blockNumber?: string;
  readonly sourceKind?: string;
  readonly decision?: string;
  readonly reasonCodes?: readonly string[];
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bound: LogContext): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly service: string;
  /** Injected so tests can capture output without touching stdout. */
  readonly sink?: (line: string) => void;
  /** Supplied explicitly; the logger does not read a clock of its own. */
  readonly clock?: () => number;
}

/**
 * Structured JSON logger.
 *
 * Every field passes through `redact` on the way out — including the message context —
 * because a secret usually reaches a log through a field nobody considered.
 */
export function createLogger(options: LoggerOptions, bound: LogContext = {}): Logger {
  const minimum = LEVEL_RANK[options.level ?? 'info'];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clock = options.clock ?? Date.now;

  const emit = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_RANK[level] < minimum) return;
    const payload = {
      level,
      time: new Date(clock()).toISOString(),
      service: options.service,
      message,
      ...(redact({ ...bound, ...context }) as Record<string, unknown>),
    };
    sink(JSON.stringify(payload));
  };

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (extra) => createLogger(options, { ...bound, ...extra }),
  };
}
