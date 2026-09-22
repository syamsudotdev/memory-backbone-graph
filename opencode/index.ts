import type { AppendRequest } from "../src/append.ts";
import { classifyKnowledgeError } from "../src/errors.ts";
import { appendKnowledgeWithGit, resolveProjectGit } from "../src/git.ts";
import { nativeToolGuidelines } from "../src/guidance.ts";
import { getKnowledge, searchKnowledge, type SearchFilters } from "../src/query.ts";

type ToolContext = { sessionID: string; signal: AbortSignal };
type Tool = { name: string; description: string; input: Record<string, unknown>; execute(input: any, context: ToolContext): Promise<{ content: string }> };
type OpenCodeContext = {
  location: { directory: string };
  tool: { transform(edit: (editor: { add(tool: Tool): void }) => void): Promise<unknown> };
  session: { hook(name: "context", callback: (event: { system: { type: string; text: string }[] }) => void): Promise<unknown> };
};

const canonicalKey = { type: "string", minLength: 3, maxLength: 4096, pattern: "^[^:]+:[^:]+$" };
const text = { type: "string", minLength: 1, maxLength: 65_536 };
const optionalText = { type: "string", maxLength: 65_536 };
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function response(operation: string, data: unknown, partial = false) {
  return { content: JSON.stringify({ ok: true, operation, partial, data }) };
}
function failure(operation: string, error: unknown) {
  return { content: JSON.stringify({ ok: false, operation, error: classifyKnowledgeError(error) }) };
}

export default {
  id: "memory-backbone",
  async setup(ctx: OpenCodeContext) {
    const root = async () => (await resolveProjectGit(ctx.location.directory)).root;
    await ctx.tool.transform(editor => {
      editor.add({
        name: "knowledge_append",
        description: "Append explicit durable knowledge to the active Git project and commit only its canonical knowledge files.",
        input: {
          type: "object", additionalProperties: false, required: ["kind", "summary", "source", "facts"],
          properties: {
            kind: { ...text, maxLength: 4096 }, summary: text, source: { ...text, maxLength: 4096 }, evidence: optionalText, tags: { ...optionalText, maxLength: 4096 },
            facts: { type: "array", minItems: 1, maxItems: 1000, items: {
              type: "object", additionalProperties: false, required: ["subject", "predicate", "object"],
              properties: { subject: canonicalKey, predicate: { ...text, maxLength: 4096 }, object: canonicalKey, confidence: { type: "number", minimum: 0, maximum: 1 }, evidence: optionalText, supersedes: { type: "string", pattern: `^fact_${uuid}$` }, tags: { ...optionalText, maxLength: 4096 } },
            } },
          },
        },
        async execute(input: Omit<AppendRequest, "sessionId">, context) {
          try { return response("append", await appendKnowledgeWithGit(await root(), { ...input, sessionId: context.sessionID })); }
          catch (error) { return failure("append", error); }
        },
      });
      editor.add({
        name: "knowledge_search",
        description: "Search current or historical durable knowledge with structured filters and provenance. Use terms for substring discovery when an exact key is unknown.",
        input: {
          type: "object", additionalProperties: false,
          properties: {
            terms: { type: "array", maxItems: 20, items: { type: "string", maxLength: 4096, pattern: "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$" } },
            subject: canonicalKey, predicate: { ...optionalText, maxLength: 4096 }, object: canonicalKey, kind: { ...optionalText, maxLength: 4096 }, agent_id: { ...optionalText, maxLength: 4096 }, session_id: { ...optionalText, maxLength: 4096 },
            from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }, to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" },
            limit: { type: "integer", minimum: 1, maximum: 100 }, history: { type: "boolean" },
          },
        },
        async execute(input: SearchFilters) {
          try { const data = await searchKnowledge(await root(), input); return response("search", data, data.partial); }
          catch (error) { return failure("search", error); }
        },
      });
      editor.add({
        name: "knowledge_get",
        description: "Retrieve one durable entity, episode, or fact by its stable ID with provenance.",
        input: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: `^(?:fact_|ep_|ent_)${uuid}$` } } },
        async execute(input: { id: string }) {
          try { const data = await getKnowledge(await root(), input.id); return response("get", data, data.partial); }
          catch (error) { return failure("get", error); }
        },
      });
    });
    await ctx.session.hook("context", event => {
      for (const text of nativeToolGuidelines) if (!event.system.some(part => part.text === text)) event.system.push({ type: "text", text });
    });
  },
};
