import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { analyzeInitialContext } from "../agents/career-sync/initial-analysis.service.js";
import { PORTFOLIO_INSPECTION_PROMPT } from "../agents/career-sync/portfolio-inspection.prompt.js";
import { llm } from "../services/llm.service.js";
import { validatePortfolio } from "../services/portfolio-validation.service.js";
import { publishPortfolioChanges } from "../services/github-publishing.service.js";
import { readFiles } from "../tools/read-file.tool.js";
import { updateFiles } from "../tools/update-files.tool.js";
import type { CareerSyncStateType, ReadFileResult, FileUpdate } from "./career-sync.state.js";
import { cleanupWorkspace } from "../tools/cleanup-workspace.tool.js";
const READ_BATCH_SIZE = 10;
const UPDATE_BATCH_SIZE = 20;
const MAX_INSPECTION_ROUNDS = 5;

/**
 * Log tool execution metadata without logging resume text or file contents.
 */
function logToolCall(
  toolName: string,
  status: "started" | "completed" | "failed",
  details: Record<string, unknown> = {},
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    component: "CareerSync",
    event: "tool_call",
    toolName,
    status,
    ...details,
  };

  if (status === "failed") {
    console.error("[CareerSync]", JSON.stringify(logEntry));
    return;
  }

  console.info("[CareerSync]", JSON.stringify(logEntry));
}

const portfolioInspectionSchema = z.object({
  summary: z.string().describe("Summary of the inspection and the decisions made."),
  needsMoreFiles: z
    .boolean()
    .describe("Whether additional portfolio files must be inspected before deciding on updates."),
  filesToRead: z
    .array(z.string().min(1))
    .describe(
      "Additional existing portfolio file paths to inspect. Empty when no more files are needed.",
    ),
  updates: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .describe(
      "Complete updated contents of existing inspected files. Empty when more files are needed or no changes are required.",
    ),
});
interface UpdateCheckpoint {
  path: string;
  absolutePath: string;
  originalContent: Buffer;
}
interface UpdateToolResult {
  success: boolean;
  totalUpdated: number;
  files: Array<{
    path: string;
    success: boolean;
    error?: string;
  }>;
  error?: string;
  rollbackSucceeded?: boolean;
  rollbackErrors?: string[];
}
function isInsideDirectory(directory: string, target: string): boolean {
  const relativePath = path.relative(directory, target);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}
/**
 * Save the original contents of every file before applying any updates.
 */
async function createUpdateCheckpoint(updates: FileUpdate[]): Promise<UpdateCheckpoint[]> {
  const repositoryPath = path.resolve(process.cwd(), "workspaces", "portfolio");
  const realRepositoryPath = await fs.realpath(repositoryPath);
  const uniquePaths = new Set(updates.map((update) => update.path));
  if (uniquePaths.size !== updates.length) {
    throw new Error("Duplicate file paths are not allowed in the update plan.");
  }
  const checkpoint: UpdateCheckpoint[] = [];
  for (const update of updates) {
    const filePath = update.path;
    const normalizedPath = path.posix.normalize(filePath);
    if (
      !filePath ||
      path.posix.isAbsolute(filePath) ||
      normalizedPath !== filePath ||
      normalizedPath === ".." ||
      normalizedPath.startsWith("../") ||
      filePath.includes("\\") ||
      filePath.includes("\0")
    ) {
      throw new Error(`Invalid repository-relative path: ${filePath}`);
    }
    const absolutePath = path.resolve(realRepositoryPath, filePath);
    if (!isInsideDirectory(realRepositoryPath, absolutePath)) {
      throw new Error(`File is outside the portfolio repository: ${filePath}`);
    }
    const targetStats = await fs.lstat(absolutePath);
    if (targetStats.isSymbolicLink()) {
      throw new Error(`Symbolic links cannot be checkpointed: ${filePath}`);
    }
    const realFilePath = await fs.realpath(absolutePath);
    if (!isInsideDirectory(realRepositoryPath, realFilePath)) {
      throw new Error(`File resolves outside the repository: ${filePath}`);
    }
    const fileStats = await fs.stat(realFilePath);
    if (!fileStats.isFile()) {
      throw new Error(`Target is not a regular file: ${filePath}`);
    }
    checkpoint.push({
      path: filePath,
      absolutePath: realFilePath,
      originalContent: await fs.readFile(realFilePath),
    });
  }
  return checkpoint;
}
/**
 * Restore the original contents of all checkpointed files.
 */
async function restoreUpdateCheckpoint(checkpoint: UpdateCheckpoint[]): Promise<string[]> {
  const errors: string[] = [];
  for (const file of [...checkpoint].reverse()) {
    try {
      await fs.writeFile(file.absolutePath, file.originalContent);
    } catch (error) {
      errors.push(
        `${file.path}: ${error instanceof Error ? error.message : "Unknown restoration error"}`,
      );
    }
  }
  return errors;
}
/**
 * Stage 1: Analyze resumes and select the initial files to inspect.
 */
export async function initialAnalysisNode(state: CareerSyncStateType) {
  if (!state.context) {
    throw new Error("CareerSync context is missing.");
  }
  const analysis = await analyzeInitialContext(state.context);

  if (analysis.filesToRead.length === 0) {
    return {
      initialAnalysis: analysis,
      filesToRead: [],
      stage: "completed" as const,
      errors: [],
    };
  }

  return {
    initialAnalysis: analysis,
    filesToRead: analysis.filesToRead,
    inspectionRounds: 0,
    stage: "reading" as const,
  };
}
/**
 * Stage 2: Read requested files in batches.
 *
 * Previously inspected files are retained in state.readResults.
 * Only newly requested files are read.
 */
export async function readPortfolioFilesNode(state: CareerSyncStateType) {
  if (!state.context) {
    throw new Error("CareerSync context is missing.");
  }
  if (!state.initialAnalysis) {
    throw new Error("Initial analysis is missing.");
  }
  console.log("[CareerSync] Current stage:", state.stage);
  console.log("[CareerSync] Files to read:", state.filesToRead);
  console.log("[CareerSync] Initial analysis:", state.initialAnalysis);
  if (state.filesToRead.length === 0) {
    return {
      stage: "failed" as const,
      errors: ["No new files were selected for inspection."],
    };
  }
  const availablePaths = new Set(state.context.portfolioFiles);
  const alreadyReadPaths = new Set(state.readResults.map((file) => file.path));
  const requestedPaths = [...new Set(state.filesToRead)];
  for (const filePath of requestedPaths) {
    if (!availablePaths.has(filePath)) {
      return {
        stage: "failed" as const,
        errors: [`Requested file is not in the tracked portfolio file list: ${filePath}`],
      };
    }
    if (alreadyReadPaths.has(filePath)) {
      return {
        stage: "failed" as const,
        errors: [`The inspection requested an already-read file: ${filePath}`],
      };
    }
  }
  const newReadResults: ReadFileResult[] = [];
  for (let index = 0; index < requestedPaths.length; index += READ_BATCH_SIZE) {
    const batch = requestedPaths.slice(index, index + READ_BATCH_SIZE);
    const batchNumber = Math.floor(index / READ_BATCH_SIZE) + 1;
    const startedAt = Date.now();

    logToolCall("readFiles", "started", {
      batchNumber,
      batchSize: batch.length,
    });

    try {
      const rawResult = await readFiles.invoke({
        paths: batch,
      });
      const parsedResult = JSON.parse(rawResult as string) as {
        success: boolean;
        files: ReadFileResult[];
      };

      newReadResults.push(...parsedResult.files);

      logToolCall("readFiles", "completed", {
        batchNumber,
        durationMs: Date.now() - startedAt,
        filesRead: parsedResult.files.length,
        failedFiles: parsedResult.files.filter((file) => !file.success).length,
        success: parsedResult.success,
      });
    } catch (error) {
      logToolCall("readFiles", "failed", {
        batchNumber,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }
  const allReadResults = [...state.readResults, ...newReadResults];
  const failedFiles = newReadResults.filter((file) => !file.success);
  if (failedFiles.length > 0) {
    return {
      readResults: allReadResults,
      stage: "failed" as const,
      errors: failedFiles.map(
        (file) => `Failed to read ${file.path}: ${file.error ?? "Unknown error"}`,
      ),
    };
  }
  return {
    readResults: allReadResults,
    filesToRead: [],
    stage: "inspecting" as const,
  };
}
/**
 * Stage 3: Inspect accumulated file contents.
 *
 * The LLM can request additional files or finish inspection and propose updates.
 */
export async function inspectPortfolioNode(state: CareerSyncStateType) {
  if (!state.context) {
    throw new Error("CareerSync context is missing.");
  }
  if (state.stage !== "inspecting") {
    throw new Error("Portfolio inspection is not allowed at this stage.");
  }
  const successfullyRead = state.readResults.filter(
    (file) => file.success && file.content !== undefined,
  );
  if (successfullyRead.length === 0) {
    throw new Error("No portfolio files were successfully read.");
  }
  const currentRound = state.inspectionRounds + 1;
  const structuredLlm = llm.withStructuredOutput(portfolioInspectionSchema);
  const result = await structuredLlm.invoke([
    {
      role: "system",
      content: PORTFOLIO_INSPECTION_PROMPT,
    },
    {
      role: "user",
      content: JSON.stringify({
        mode: "inspect",
        previousResume: state.context.previousResume,
        newResume: state.context.newResume,
        portfolioStructure: state.context.portfolioStructure,
        initialAnalysis: state.initialAnalysis,
        availablePortfolioFiles: state.context.portfolioFiles,
        alreadyInspectedPaths: successfullyRead.map((file) => file.path),
        inspectedFiles: successfullyRead.map((file) => ({
          path: file.path,
          content: file.content,
        })),
        inspectionRound: currentRound,
        maxInspectionRounds: MAX_INSPECTION_ROUNDS,
      }),
    },
  ]);
  if (result.needsMoreFiles) {
    if (currentRound >= MAX_INSPECTION_ROUNDS) {
      return {
        inspectionRounds: currentRound,
        stage: "failed" as const,
        errors: [
          `Inspection limit reached (${MAX_INSPECTION_ROUNDS} rounds). The LLM still requires additional files, so updates were not applied.`,
        ],
      };
    }
    if (result.updates.length > 0) {
      return {
        inspectionRounds: currentRound,
        stage: "failed" as const,
        errors: [
          "Invalid inspection response: updates were returned while additional files were requested.",
        ],
      };
    }
    if (result.filesToRead.length === 0) {
      return {
        inspectionRounds: currentRound,
        stage: "failed" as const,
        errors: ["The LLM requested additional inspection but did not provide any file paths."],
      };
    }
    const availablePaths = new Set(state.context.portfolioFiles);
    const inspectedPaths = new Set(successfullyRead.map((file) => file.path));
    const requestedPaths = [...new Set(result.filesToRead)];
    for (const filePath of requestedPaths) {
      if (!availablePaths.has(filePath)) {
        return {
          inspectionRounds: currentRound,
          stage: "failed" as const,
          errors: [`The LLM requested a file that is not in the portfolio: ${filePath}`],
        };
      }
      if (inspectedPaths.has(filePath)) {
        return {
          inspectionRounds: currentRound,
          stage: "failed" as const,
          errors: [`The LLM requested an already-inspected file: ${filePath}`],
        };
      }
    }
    return {
      inspectionRounds: currentRound,
      filesToRead: requestedPaths,
      filesToUpdate: [],
      stage: "reading" as const,
    };
  }
  if (result.filesToRead.length > 0) {
    return {
      inspectionRounds: currentRound,
      stage: "failed" as const,
      errors: [
        "Invalid inspection response: file paths were requested even though inspection was marked complete.",
      ],
    };
  }
  const inspectedPaths = new Set(successfullyRead.map((file) => file.path));
  const updates: FileUpdate[] = result.updates.map((update) => {
    if (!inspectedPaths.has(update.path)) {
      throw new Error(`LLM proposed an update for an unread file: ${update.path}`);
    }
    return {
      path: update.path,
      content: update.content,
    };
  });
  return {
    inspectionRounds: currentRound,
    filesToRead: [],
    filesToUpdate: updates,
    stage: updates.length > 0 ? ("updating" as const) : ("completed" as const),
  };
}
/**
 * Stage 4: Apply proposed updates in batches.
 *
 * All original file contents are checkpointed before the first write.
 * If any batch fails, every checkpointed file is restored.
 */
export async function updatePortfolioFilesNode(state: CareerSyncStateType) {
  if (state.stage !== "updating") {
    throw new Error("Portfolio updates are not allowed at this stage.");
  }
  if (state.filesToUpdate.length === 0) {
    return {
      stage: "completed" as const,
    };
  }
  // Checkpoint every file before modifying any of them.
  const checkpoint = await createUpdateCheckpoint(state.filesToUpdate);
  const updatedPaths: string[] = [];
  try {
    for (let index = 0; index < state.filesToUpdate.length; index += UPDATE_BATCH_SIZE) {
      const batch = state.filesToUpdate.slice(index, index + UPDATE_BATCH_SIZE);
      const batchNumber = Math.floor(index / UPDATE_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(state.filesToUpdate.length / UPDATE_BATCH_SIZE);
      const startedAt = Date.now();

      logToolCall("updateFiles", "started", {
        batchNumber,
        totalBatches,
        batchSize: batch.length,
      });

      let result: UpdateToolResult;

      try {
        const rawResult = await updateFiles.invoke({
          files: batch,
        });
        result = JSON.parse(rawResult as string) as UpdateToolResult;
      } catch (error) {
        logToolCall("updateFiles", "failed", {
          batchNumber,
          totalBatches,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      }

      const failedFiles = result.files.filter((file) => !file.success);

      logToolCall(
        "updateFiles",
        result.success && failedFiles.length === 0 ? "completed" : "failed",
        {
          batchNumber,
          totalBatches,
          durationMs: Date.now() - startedAt,
          filesUpdated: result.totalUpdated,
          failedFiles: failedFiles.length,
          success: result.success && failedFiles.length === 0,
        },
      );
      if (!result.success || failedFiles.length > 0) {
        const failureDetails = failedFiles
          .map((file) => `${file.path}: ${file.error ?? "Unknown error"}`)
          .join("; ");
        const message = failureDetails || result.error || "The update tool reported a failure.";
        const toolRollbackDetails =
          result.rollbackSucceeded === false
            ? ` The update tool also reported incomplete rollback: ${
                result.rollbackErrors?.join("; ") || "Unknown rollback error"
              }`
            : "";
        throw new Error(`File updates failed: ${message}.${toolRollbackDetails}`);
      }
      updatedPaths.push(...result.files.map((file) => file.path));
    }
    return {
      updatedPaths,
      stage: "validating" as const,
    };
  } catch (error) {
    const originalError = error instanceof Error ? error.message : "Unknown update error";
    const rollbackErrors = await restoreUpdateCheckpoint(checkpoint);
    if (rollbackErrors.length > 0) {
      throw new Error(
        [
          `File updates failed: ${originalError}`,
          "Checkpoint restoration was incomplete.",
          `Files requiring manual recovery: ${rollbackErrors.join("; ")}`,
        ].join(" "),
      );
    }
    throw new Error(
      `File updates failed: ${originalError} All checkpointed files were restored to their original contents.`,
    );
  }
}
/**
 * Stage 5: Validate the updated portfolio.
 */
export async function validatePortfolioNode(state: CareerSyncStateType) {
  if (state.stage !== "validating") {
    throw new Error("Portfolio validation is not allowed at this stage.");
  }
  const result = await validatePortfolio();
  if (!result.success) {
    return {
      stage: "failed" as const,
      errors: result.messages,
    };
  }
  return {
    stage: "publishing" as const,
  };
}
/**
 * Stage 6: Publish changes and open a pull request.
 */
export async function publishPortfolioNode(state: CareerSyncStateType) {
  if (state.stage !== "publishing") {
    throw new Error("Publishing is not allowed at this stage.");
  }

  if (state.updatedPaths.length === 0) {
    throw new Error("No successfully updated files are available to publish.");
  }

  if (!state.resumeBuffer) {
    throw new Error("Uploaded resume buffer is missing.");
  }

  const result = await publishPortfolioChanges(state.updatedPaths, state.resumeBuffer);
  return {
    stage: "completed" as const,
    pullRequestUrl: result.pullRequestUrl,
  };
}
