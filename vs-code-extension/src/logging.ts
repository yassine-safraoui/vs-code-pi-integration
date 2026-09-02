export interface PiContextOutput {
  readonly appendLine: (value: string) => void;
  readonly show: (preserveFocus?: boolean) => void;
}

let output: PiContextOutput | undefined;

const redactedKey = (key: string): boolean =>
  /token|authorization|attachmentText|content/i.test(key);

const safeFields = (fields: Readonly<Record<string, unknown>>): string => {
  const safe = Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    redactedKey(key) ? "[redacted]" : value
  ]));
  return Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : "";
};

const write = (level: "INFO" | "WARN" | "ERROR", event: string, fields: Readonly<Record<string, unknown>>): void => {
  output?.appendLine(`${new Date().toISOString()} [${level}] ${event}${safeFields(fields)}`);
};

export const configurePiContextOutput = (next: PiContextOutput): void => {
  output = next;
};

export const showPiContextOutput = (): void => output?.show(true);

export const logInfo = (event: string, fields: Readonly<Record<string, unknown>> = {}): void =>
  write("INFO", event, fields);

export const logWarning = (event: string, fields: Readonly<Record<string, unknown>> = {}): void =>
  write("WARN", event, fields);

export const logError = (
  event: string,
  cause: unknown,
  fields: Readonly<Record<string, unknown>> = {}
): void => write("ERROR", event, {
  ...fields,
  error: cause instanceof Error ? cause.message : String(cause),
  ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {})
});
