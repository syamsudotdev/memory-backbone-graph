export const knowledgeGuidelines = [
  "Before making a decision that prior project context can affect, use knowledge_search to recall relevant durable knowledge.",
  "Before the final response, use knowledge_append for explicit or verified knowledge that will help a future session; do not store temporary progress, speculation, or secrets.",
];

export function addKnowledgeGuidelines(event: { systemPromptOptions: { promptGuidelines: string[] } }) {
  for (const guideline of knowledgeGuidelines) {
    if (!event.systemPromptOptions.promptGuidelines.includes(guideline)) event.systemPromptOptions.promptGuidelines.push(guideline);
  }
}
