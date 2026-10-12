import { z } from "zod";
import { llm } from "../../services/llm.service.js";
import type { CareerSyncContext } from "../../services/career-sync-context.service.js";
import { PORTFOLIO_INSPECTION_PROMPT } from "./portfolio-inspection.prompt.js";

const initialAnalysisSchema = z.object({
  summary: z.string(),

  filesToRead: z.array(z.string()),

  reasoning: z.string(),
});

export type InitialAnalysis = z.infer<typeof initialAnalysisSchema>;

export async function analyzeInitialContext(context: CareerSyncContext): Promise<InitialAnalysis> {
  const structuredLlm = llm.withStructuredOutput(initialAnalysisSchema);

  const result = await structuredLlm.invoke([
    {
      role: "system",
      content: PORTFOLIO_INSPECTION_PROMPT,
    },
    {
      role: "user",
      content: JSON.stringify({
        mode: "preflight",
        previousResume: context.previousResume,
        newResume: context.newResume,
        portfolioFiles: context.portfolioFiles,
        portfolioStructure: context.portfolioStructure,
        inspectedFiles: [],
        inspectedFileContents: {},
      }),
    },
  ]);

  console.log("[CareerSync] Initial analysis result:", JSON.stringify(result, null, 2));

  const availableFiles = new Set(context.portfolioFiles);
  const invalidFiles = result.filesToRead.filter((file) => !availableFiles.has(file));

  if (invalidFiles.length > 0) {
    throw new Error(
      `LLM selected files that do not exist in the repository: ${invalidFiles.join(", ")}`,
    );
  }

  return result;
}
