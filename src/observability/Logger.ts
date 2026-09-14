// ============================================================
// Logger — BD_API_ZEISS Platform
// ============================================================

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export interface LogEntry {
  level: LogLevel;
  component: string;
  operation?: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface ILogger {
  debug(component: string, message: string, metadata?: Record<string, unknown>): void;
  info(component: string, message: string, metadata?: Record<string, unknown>): void;
  warn(component: string, message: string, metadata?: Record<string, unknown>): void;
  error(component: string, message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Structured console logger. Produces JSON lines for observability.
 * In production, this could be replaced by a transport that writes
 * to provider_health or an external logging service.
 */
export class ConsoleLogger implements ILogger {
  private emit(level: LogLevel, component: string, message: string, metadata?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      component,
      message,
      metadata,
      timestamp: new Date(),
    };
    const line = JSON.stringify(entry);
    if (level === LogLevel.ERROR) {
      console.error(line);
    } else if (level === LogLevel.WARN) {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(component: string, message: string, metadata?: Record<string, unknown>): void {
    this.emit(LogLevel.DEBUG, component, message, metadata);
  }

  info(component: string, message: string, metadata?: Record<string, unknown>): void {
    this.emit(LogLevel.INFO, component, message, metadata);
  }

  warn(component: string, message: string, metadata?: Record<string, unknown>): void {
    this.emit(LogLevel.WARN, component, message, metadata);
  }

  error(component: string, message: string, metadata?: Record<string, unknown>): void {
    this.emit(LogLevel.ERROR, component, message, metadata);
  }
}

/** Silent logger for tests. */
export class NullLogger implements ILogger {
  debug(): void { /* noop */ }
  info(): void { /* noop */ }
  warn(): void { /* noop */ }
  error(): void { /* noop */ }
}
