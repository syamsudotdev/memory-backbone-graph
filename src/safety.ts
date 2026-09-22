const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i;
const ACCESS_TOKEN = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-(?:live-)?[A-Za-z0-9]{20,})\b/;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
const CREDENTIAL_ASSIGNMENT = /\b(?:password|secret|api[ _-]?key|token)\s*[:=]\s*["']?[^\s"',;]{8,}/i;

export const MAX_FACTS_PER_APPEND = 1000;
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_KEY_BYTES = 4096;
export const MAX_CSV_BYTES = 256 * 1024 * 1024;

export function validateCsvByteLength(bytes: number, limit = MAX_CSV_BYTES): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Math.min(limit, MAX_CSV_BYTES)) throw new Error("CSV input exceeds size limit");
}

export function validateRequestByteLength(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_REQUEST_BYTES) throw new Error("request exceeds size limit");
}

export type SecretCategory = "private-key" | "access-token" | "credential-url" | "credential-assignment";

export function validateText(value: unknown, label: string, options: { optional?: boolean; multiline?: boolean; maxBytes?: number } = {}): string {
  if (value === undefined && options.optional) return "";
  if (typeof value !== "string" || (!options.optional && (!value || value !== value.trim()))) throw new Error(`invalid ${label}`);
  const controls = options.multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
  if (controls.test(value) || Buffer.byteLength(value, "utf8") > (options.maxBytes ?? MAX_KEY_BYTES)) throw new Error(`invalid ${label}`);
  return value;
}

export function secretCategory(value: string): SecretCategory | undefined {
  if (PRIVATE_KEY.test(value)) return "private-key";
  if (ACCESS_TOKEN.test(value)) return "access-token";
  if (CREDENTIAL_URL.test(value)) return "credential-url";
  if (CREDENTIAL_ASSIGNMENT.test(value)) return "credential-assignment";
  return undefined;
}

export function rejectSecrets(values: readonly string[]): void {
  for (const value of values) {
    const category = secretCategory(value);
    if (category) throw new Error(`sensitive data rejected: ${category}`);
  }
}
