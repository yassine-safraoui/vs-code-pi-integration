export interface PiContextLogger {
  readonly info: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly error: (event: string, cause: unknown, fields?: Readonly<Record<string, unknown>>) => void;
}

export const silentLogger: PiContextLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const redactedKey = (key: string): boolean =>
  /token|authorization|attachmentText|content/i.test(key);

const safeFields = (fields: Readonly<Record<string, unknown>>): string => {
  const safe = Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    redactedKey(key) ? "[redacted]" : value
  ]));
  return Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : "";
};

export const makeTerminalLogger = (): PiContextLogger => {
  const fs = require("fs");
  const path = require("path");
  const logFile = path.join(__dirname, "logs.log");

  const write = (
    level: "INFO" | "WARN" | "ERROR",
    event: string,
    fields: Readonly<Record<string, unknown>>
  ): void => {
    const line = `${new Date().toISOString()} [pi-context] [${level}] ${event}${safeFields(fields)}\n`;
    fs.appendFileSync(logFile, line);
  };
  return {
    info: (event, fields = {}) => write("INFO", event, fields),
    warn: (event, fields = {}) => write("WARN", event, fields),
    error: (event, cause, fields = {}) => write("ERROR", event, {
      ...fields,
      error: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {})
    })
  };
};
