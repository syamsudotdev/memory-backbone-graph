export const recallGuidance = "Recall relevant durable knowledge before making a decision that prior project context can affect.";
export const captureGuidance = "Before the final response, record explicit or verified knowledge that will help a future session; do not store temporary progress, speculation, or secrets.";
export const nativeToolGuidelines = [`${recallGuidance} Use knowledge_search for recall.`, `${captureGuidance} Use knowledge_append to record it.`];
