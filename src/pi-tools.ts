import type { AppendFact } from "./append.ts";
import { KnowledgeError } from "./errors.ts";
import { appendKnowledgeWithGit, resolveProjectGit } from "./git.ts";
import { getKnowledge, searchKnowledge } from "./query.ts";
import type { SearchFilters } from "./query.ts";

type SchemaBuilder = {
  Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  String(options?: Record<string, unknown>): unknown;
  Number(options?: Record<string, unknown>): unknown;
  Integer(options?: Record<string, unknown>): unknown;
  Boolean(options?: Record<string, unknown>): unknown;
  Array(items: unknown, options?: Record<string, unknown>): unknown;
  Optional(schema: unknown): unknown;
};
type ToolContext = { cwd: string; sessionManager?: { getSessionId(): string } };
type ToolDefinition = { name: string; label: string; description: string; parameters: unknown; execute(id: string, params: any, signal: AbortSignal | undefined, update: unknown, context: ToolContext): Promise<unknown> };
type PiApi = { registerTool(definition: ToolDefinition): void };

type DomainError = { category: KnowledgeError["category"]; message: string; canonicalDataPreserved: boolean; appendCanContinue: boolean };
type Operations = {
  resolveProjectGit: typeof resolveProjectGit;
  appendKnowledgeWithGit: typeof appendKnowledgeWithGit;
  searchKnowledge: typeof searchKnowledge;
  getKnowledge: typeof getKnowledge;
};
const defaultOperations: Operations = { resolveProjectGit, appendKnowledgeWithGit, searchKnowledge, getKnowledge };

function classify(error: unknown): DomainError {
  const message = error instanceof Error ? error.message : "knowledge operation failed";
  if (error instanceof KnowledgeError) return { category: error.category, message, canonicalDataPreserved: true, appendCanContinue: error.appendCanContinue };
  return { category: "unknown", message, canonicalDataPreserved: true, appendCanContinue: false };
}

function success(operation: string, data: unknown, partial = false) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, operation, partial, data }) }], details: { ok: true, operation, partial, data } };
}
function failure(operation: string, error: unknown) {
  const issue = classify(error);
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, operation, error: issue }) }], details: { ok: false, operation, error: issue } };
}
export function registerKnowledgeTools(pi: PiApi, Type: SchemaBuilder, operations: Operations = defaultOperations) {
  async function projectRoot(context: ToolContext) { return (await operations.resolveProjectGit(context.cwd)).root; }
  const strict = { additionalProperties: false };
  const text = (maxLength = 65_536) => Type.String({ minLength: 1, maxLength });
  const optionalText = (maxLength = 65_536) => Type.Optional(Type.String({ maxLength }));
  const canonicalKey = () => Type.String({ minLength: 3, maxLength: 4096, pattern: "^[^:]+:[^:]+$" });
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const stableId = Type.String({ pattern: `^(?:fact_|ep_|ent_)${uuid}$` });
  const factId = Type.String({ pattern: `^fact_${uuid}$` });
  const timestamp = () => Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
  const fact = Type.Object({
    subject: canonicalKey(), predicate: text(4096), object: canonicalKey(),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    evidence: optionalText(), supersedes: Type.Optional(factId), tags: optionalText(4096),
  }, strict);

  pi.registerTool({
    name: "knowledge_append",
    label: "Append Knowledge",
    description: "Append explicit durable knowledge to the active Git project and commit only its canonical knowledge files.",
    parameters: Type.Object({
      kind: text(4096), summary: text(), source: text(4096), evidence: optionalText(), tags: optionalText(4096),
      facts: Type.Array(fact, { minItems: 1, maxItems: 1000 }),
    }, strict),
    async execute(_id, params: { kind: string; summary: string; source: string; evidence?: string; tags?: string; facts: AppendFact[] }, _signal, _update, context) {
      try {
        const sessionId = context.sessionManager?.getSessionId();
        if (!sessionId) return failure("append", new KnowledgeError("setup", "stable Pi session ID is unavailable"));
        const root = await projectRoot(context);
        return success("append", await operations.appendKnowledgeWithGit(root, { ...params, sessionId }));
      } catch (error) { return failure("append", error); }
    },
  });

  pi.registerTool({
    name: "knowledge_search",
    label: "Search Knowledge",
    description: "Search current or historical durable knowledge with structured filters and provenance. Use terms for case-insensitive substring discovery when the exact subject or object key is unknown, then reuse discovered keys as exact filters.",
    parameters: Type.Object({
      terms: Type.Optional(Type.Array(Type.String({ maxLength: 4096, pattern: "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$" }), { maxItems: 20 })),
      subject: Type.Optional(canonicalKey()), predicate: optionalText(4096), object: Type.Optional(canonicalKey()), kind: optionalText(4096), agent_id: optionalText(4096), session_id: optionalText(4096),
      from: Type.Optional(timestamp()), to: Type.Optional(timestamp()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), history: Type.Optional(Type.Boolean()),
    }, strict),
    async execute(_id, params: SearchFilters, _signal, _update, context) {
      try { const root = await projectRoot(context), result = await operations.searchKnowledge(root, params); return success("search", result, result.partial); }
      catch (error) { return failure("search", error); }
    },
  });

  pi.registerTool({
    name: "knowledge_get",
    label: "Get Knowledge",
    description: "Retrieve one durable entity, episode, or fact by its stable ID with provenance.",
    parameters: Type.Object({ id: stableId }, strict),
    async execute(_id, params: { id: string }, _signal, _update, context) {
      try { const root = await projectRoot(context), result = await operations.getKnowledge(root, params.id); return success("get", result, result.partial); }
      catch (error) { return failure("get", error); }
    },
  });
}
