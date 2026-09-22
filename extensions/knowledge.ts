import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addKnowledgeGuidelines } from "./lifecycle.ts";
import { registerKnowledgeTools } from "./tools.ts";

export default function knowledgeExtension(pi: ExtensionAPI) {
  registerKnowledgeTools(pi, Type);
  pi.on("before_agent_start", addKnowledgeGuidelines);
}
