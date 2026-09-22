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

export function knowledgeError(category: KnowledgeErrorCategory, error: unknown, appendCanContinue = false) {
  if (error instanceof KnowledgeError) return error;
  const message = error instanceof Error ? error.message : "knowledge operation failed";
  return new KnowledgeError(category, message, { appendCanContinue, cause: error });
}
