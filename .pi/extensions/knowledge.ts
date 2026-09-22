import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerKnowledgeTools } from "../../src/pi-tools.ts";

export default function knowledgeExtension(pi: ExtensionAPI) {
  registerKnowledgeTools(pi, Type);
}
