import { captureGuidance, recallGuidance } from "../src/guidance.ts";

export const knowledgeGuidelines = [
  `${recallGuidance} Use knowledge_search for recall.`,
  `${captureGuidance} Use knowledge_append to record it.`,
];

export function addKnowledgeGuidelines(event: { systemPromptOptions: { promptGuidelines: string[] } }) {
  for (const guideline of knowledgeGuidelines) {
    if (!event.systemPromptOptions.promptGuidelines.includes(guideline)) event.systemPromptOptions.promptGuidelines.push(guideline);
  }
}
