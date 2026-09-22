export type KnowledgeErrorCategory = "setup" | "dependency" | "bootstrap" | "validation" | "duplicate" | "lock" | "git" | "unknown";

export class KnowledgeError extends Error {
  readonly category: KnowledgeErrorCategory;
  readonly appendCanContinue: boolean;

  constructor(category: KnowledgeErrorCategory, message: string, options: { appendCanContinue?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "KnowledgeError";
    this.category = category;
    this.appendCanContinue = options.appendCanContinue ?? false;
  }
}

export type DomainError = { category: KnowledgeErrorCategory; message: string; canonicalDataPreserved: true; appendCanContinue: boolean };

export function classifyKnowledgeError(error: unknown): DomainError {
  const message = error instanceof Error ? error.message : "knowledge operation failed";
  if (error instanceof KnowledgeError) return { category: error.category, message, canonicalDataPreserved: true, appendCanContinue: error.appendCanContinue };
  return { category: "unknown", message, canonicalDataPreserved: true, appendCanContinue: false };
}

export function knowledgeError(category: KnowledgeErrorCategory, error: unknown, appendCanContinue = false) {
  if (error instanceof KnowledgeError) return error;
  const message = error instanceof Error ? error.message : "knowledge operation failed";
  return new KnowledgeError(category, message, { appendCanContinue, cause: error });
}
