# Manual Pi Verification

This procedure verifies direct TypeScript loading and the real Pi tool registry. Automated tests verify tool execution without nested model, prompt, network-inference, extraction, or arbitrary-SQL paths.

## Initial state

- Working directory: `/home/syamsudotdev/Projects/memory-backbone-graph`
- Node.js: 24 or newer.
- Pi is installed and available as `pi`.
- `.pi/extensions/knowledge.ts` exists.
- No Pi prompt is submitted.
- The diagnostic RPC session uses `--no-session`, `--offline`, `--no-extensions`, and `--no-builtin-tools`.

## Exact actions

Create `/tmp/knowledge-tool-list.ts` with this diagnostic wrapper:

```ts
import knowledge from "/home/syamsudotdev/Projects/memory-backbone-graph/.pi/extensions/knowledge.ts";
export default function (pi: any) {
  knowledge(pi);
  pi.on("session_start", () => {
    console.error("KNOWLEDGE_TOOLS=" + pi.getAllTools().map((tool: any) => tool.name).filter((name: string) => name.startsWith("knowledge_")).join(","));
  });
}
```

Run:

```sh
printf '%s\n' '{"id":"state","type":"get_state"}' | timeout 5 pi --mode rpc --no-session --offline --no-extensions --no-builtin-tools -e /tmp/knowledge-tool-list.ts 2>&1
```

## Expected observable result

- Pi reports `KNOWLEDGE_TOOLS=knowledge_append,knowledge_search,knowledge_get`.
- The RPC `get_state` response has `success: true`.
- The response has `messageCount: 0`.
- No prompt, assistant message, or model request event appears.

## Failure condition

Verification fails if the extension does not load, a tool name is absent or additional, the RPC response fails, `messageCount` is not zero, or any prompt/model event appears.

## Actual evidence

The command exited successfully during ticket 007 verification. It printed:

```text
KNOWLEDGE_TOOLS=knowledge_append,knowledge_search,knowledge_get
```

It then printed one successful `get_state` response with `messageCount: 0`. No prompt was sent. No assistant message or model request event appeared. `test/pi-tools.test.ts` separately executed append, search, and get handlers and verified that their dependency path contains no model client, prompt, network-inference, extraction, embedding, or arbitrary-SQL hook.
