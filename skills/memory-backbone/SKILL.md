---
name: memory-backbone
description: Uses durable project knowledge through knowledge_search, knowledge_get, and knowledge_append. Use when prior decisions, preferences, constraints, or lessons can affect work, or when new verified knowledge will help a future session.
---

# Memory Backbone

Use project memory when it can change the work. Keep it small and trustworthy.

## Recall

1. Search before making a decision that can depend on prior project knowledge.
2. When a subject or object key is unknown, search `terms` with a short identifying fragment. Terms use case-insensitive literal substring matching across facts and episode text.
3. Reuse discovered canonical keys in exact `subject` or `object` filters.
4. Use narrow structured filters when the subject or relation is known.
5. Use `knowledge_get` when a result references a fact, episode, or entity that needs exact provenance.
6. Treat no result as no stored knowledge, not proof that the knowledge is false.

Recall is complete when the relevant current facts and their provenance are known, or the search returns no relevant facts.

## Record

Call `knowledge_append` after the user states or the work verifies knowledge that will help a future session. Good records include decisions, stable preferences, constraints, resolved causes, and reusable lessons.

Write one episode for one context. Put related assertions in its `facts` array. Use stable canonical keys such as `project:memory-backbone` and `tool:duckdb`. Include evidence when it improves later verification.

When knowledge changes, append the replacement fact with `supersedes`. Preserve history instead of rewriting an earlier record.

Record only information that is:

- explicit or directly verified;
- durable beyond the current task;
- useful to another agent;
- safe to commit to Git.

Leave temporary progress, speculation, transcripts, credentials, personal data, and facts that are cheaper to read from the current source code out of memory.

Recording is complete when each fact is independently useful, correctly scoped, and supported by the episode source.

## Tool availability

If the knowledge tools are unavailable, continue the task without memory. Do not substitute an untracked local note for canonical project knowledge.
