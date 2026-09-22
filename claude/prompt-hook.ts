import { join } from "node:path";
import { classifyKnowledgeError, KnowledgeError } from "../src/errors.ts";
import { captureGuidance, recallGuidance } from "../src/guidance.ts";

try {
  process.stdin.setEncoding("utf8"); let raw = ""; for await (const chunk of process.stdin) raw += chunk;
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new KnowledgeError("validation", "invalid JSON input"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new KnowledgeError("validation", "hook input must be an object");
  const event = input as { hook_event_name?: unknown; session_id?: unknown };
  if (event.hook_event_name !== "UserPromptSubmit") throw new KnowledgeError("validation", "expected UserPromptSubmit hook event");
  if (typeof event.session_id !== "string" || !event.session_id) throw new KnowledgeError("validation", "session_id is required");
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) throw new KnowledgeError("setup", "CLAUDE_PLUGIN_ROOT is unavailable");
  const cli = join(root, "claude", "knowledge-cli.ts");
  const additionalContext = [
    recallGuidance,
    `Use the knowledge adapter by piping one JSON request to node ${JSON.stringify(cli)}. The request shape is {"operation":"search|get|append","params":{...}}; append also requires "sessionId":${JSON.stringify(event.session_id)}.`,
    captureGuidance,
  ].join("\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }) + "\n");
} catch (error) {
  const { category, message } = classifyKnowledgeError(error);
  process.stderr.write(JSON.stringify({ ok: false, error: { category, message } }) + "\n");
  process.exitCode = 1;
}
