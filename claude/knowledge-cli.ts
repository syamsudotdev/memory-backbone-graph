import type { AppendRequest } from "../src/append.ts";
import { classifyKnowledgeError, KnowledgeError } from "../src/errors.ts";
import { appendKnowledgeWithGit, resolveProjectGit } from "../src/git.ts";
import { getKnowledge, searchKnowledge, type SearchFilters } from "../src/query.ts";

type Request = { operation: string; sessionId?: string; params: Record<string, unknown> };

function parse(input: string): Request {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new KnowledgeError("validation", "invalid JSON input"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeError("validation", "request must be an object");
  const request = value as Partial<Request>;
  if (typeof request.operation !== "string") throw new KnowledgeError("validation", "operation is required");
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) throw new KnowledgeError("validation", "params must be an object");
  return request as Request;
}

async function execute(request: Request) {
  if (request.operation !== "append" && request.operation !== "search" && request.operation !== "get") throw new KnowledgeError("validation", `unknown operation: ${request.operation}`);
  const { root } = await resolveProjectGit(process.cwd());
  if (request.operation === "search") return searchKnowledge(root, request.params as SearchFilters);
  if (request.operation === "get") return getKnowledge(root, request.params.id as string);
  if (request.operation === "append") {
    if (!request.sessionId) throw new KnowledgeError("validation", "sessionId is required for append");
    return appendKnowledgeWithGit(root, { ...request.params, sessionId: request.sessionId } as AppendRequest);
  }
}

let operation: string | undefined;
try {
  process.stdin.setEncoding("utf8"); let input = ""; for await (const chunk of process.stdin) input += chunk;
  const request = parse(input); operation = request.operation;
  const data = await execute(request);
  process.stdout.write(JSON.stringify({ ok: true, operation, data }) + "\n");
} catch (error) {
  const { category, message } = classifyKnowledgeError(error);
  process.stderr.write(JSON.stringify({ ok: false, ...(operation ? { operation } : {}), error: { category, message } }) + "\n");
  process.exitCode = 1;
}
