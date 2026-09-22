import { nativeToolGuidelines } from "../src/guidance.ts";

export const knowledgeGuidelines = nativeToolGuidelines;

export function addKnowledgeGuidelines(event: { systemPromptOptions: { promptGuidelines: string[] } }) {
  for (const guideline of knowledgeGuidelines) {
    if (!event.systemPromptOptions.promptGuidelines.includes(guideline)) event.systemPromptOptions.promptGuidelines.push(guideline);
  }
}
