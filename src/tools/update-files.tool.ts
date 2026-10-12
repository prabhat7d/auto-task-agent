import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { ensurePortfolioRepository } from "../services/portfolio-repository.service.js";

const execFileAsync = promisify(execFile);

const MAX_FILES_PER_BATCH = 20;
const MAX_FILE_SIZE = 100 * 1024;
const MAX_TOTAL_SIZE = 500 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".css",
  ".scss",
  ".html",
  ".json",
  ".md",
  ".txt",
  ".svg",
]);

const BLOCKED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const updateFilesSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .min(1)
    .max(MAX_FILES_PER_BATCH),
});

interface UpdateResult {
  path: string;
  success: boolean;
  error?: string;
}

interface ValidatedFile {
  path: string;
  absolutePath: string;
  content: string;
  originalContent: Buffer;
}

function isInsideDirectory(directory: string, target: string): boolean {
  const relativePath = path.relative(directory, target);

  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function validateRepositoryRelativePath(filePath: string): string | null {
  const normalizedPath = path.posix.normalize(filePath);

  if (
    path.posix.isAbsolute(filePath) ||
    normalizedPath !== filePath ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    filePath.includes("\\") ||
    filePath.includes("\0")
  ) {
    return "Invalid repository-relative path.";
  }

  return null;
}

function validateFileType(filePath: string): string | null {
  const fileName = path.posix.basename(filePath).toLowerCase();
  const extension = path.posix.extname(fileName);

  if (
    BLOCKED_FILES.has(fileName) ||
    fileName.startsWith(".env.") ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".key")
  ) {
    return "Updating this file is not allowed.";
  }

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return `Unsupported file type: ${extension || "no extension"}.`;
  }

  return null;
}

export const updateFiles = tool(
  async ({ files }) => {
    const uniquePaths = new Set(files.map((file) => file.path));

    // Reject duplicate paths before performing any filesystem operations.
    if (uniquePaths.size !== files.length) {
      return JSON.stringify({
        success: false,
        totalRequested: files.length,
        totalUpdated: 0,
        files: files.map((file) => ({
          path: file.path,
          success: false,
          error: "Duplicate file paths are not allowed in the same batch.",
        })),
      });
    }

    let repositoryPath = path.resolve(process.cwd(), "workspaces", "portfolio");

    // Reuse the existing clone, including changes made by earlier batches.
    try {
      await fs.access(path.join(repositoryPath, ".git"));
    } catch {
      repositoryPath = await ensurePortfolioRepository();
    }

    const realRepositoryPath = await fs.realpath(repositoryPath);

    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: realRepositoryPath,
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const trackedFiles = new Set(
      stdout
        .split("\n")
        .map((file) => file.trim())
        .filter(Boolean),
    );

    const results: UpdateResult[] = [];
    const validatedFiles: ValidatedFile[] = [];

    let totalSize = 0;

    /*
     * Phase 1: Validate the entire batch.
     *
     * No files are written during this phase.
     */
    for (const file of files) {
      const filePath = file.path;
      const contentSize = Buffer.byteLength(file.content, "utf8");

      const fail = (error: string) => {
        results.push({
          path: filePath,
          success: false,
          error,
        });
      };

      const pathError = validateRepositoryRelativePath(filePath);

      if (pathError) {
        fail(pathError);
        continue;
      }

      if (!trackedFiles.has(filePath)) {
        fail("Only existing Git-tracked files can be updated.");
        continue;
      }

      const fileTypeError = validateFileType(filePath);

      if (fileTypeError) {
        fail(fileTypeError);
        continue;
      }

      if (contentSize > MAX_FILE_SIZE) {
        fail("File content exceeds the 100 KB limit.");
        continue;
      }

      if (totalSize + contentSize > MAX_TOTAL_SIZE) {
        fail("Batch exceeds the 500 KB total content limit.");
        continue;
      }

      const absolutePath = path.resolve(realRepositoryPath, filePath);

      if (!isInsideDirectory(realRepositoryPath, absolutePath)) {
        fail("Path is outside the repository.");
        continue;
      }

      try {
        // Resolve the target and ensure it remains inside the repository.
        const realFilePath = await fs.realpath(absolutePath);

        if (!isInsideDirectory(realRepositoryPath, realFilePath)) {
          throw new Error("File resolves outside the repository.");
        }

        // Do not follow a symbolic link at the target path.
        const targetStats = await fs.lstat(absolutePath);

        if (targetStats.isSymbolicLink()) {
          throw new Error("Symbolic links cannot be updated.");
        }

        const stats = await fs.stat(realFilePath);

        if (!stats.isFile()) {
          throw new Error("Target is not a regular file.");
        }

        // Save original contents before any writes begin.
        const originalContent = await fs.readFile(realFilePath);

        validatedFiles.push({
          path: filePath,
          absolutePath: realFilePath,
          content: file.content,
          originalContent,
        });

        totalSize += contentSize;

        // IMPORTANT: Do not assign an error to a valid file.
        // Its success remains false until the write phase completes.
        results.push({
          path: filePath,
          success: false,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : "Failed to validate file.");
      }
    }

    /*
     * If any file failed validation, reject the entire batch.
     * No files will have been written at this point.
     */
    const validationFailed =
      results.length !== files.length ||
      results.some((result) => result.error !== undefined) ||
      validatedFiles.length !== files.length;

    if (validationFailed) {
      return JSON.stringify({
        success: false,
        totalRequested: files.length,
        totalUpdated: 0,
        files: results.map((result) => ({
          ...result,
          error: result.error ?? "Batch rejected because another file failed validation.",
        })),
      });
    }

    /*
     * Phase 2: Write the validated files.
     *
     * If a write fails, restore the original contents of every file
     * that may have been modified, including the file whose write failed.
     */
    const attemptedFiles: ValidatedFile[] = [];

    try {
      for (const file of validatedFiles) {
        // Record before writing because a failed write may be partial.
        attemptedFiles.push(file);

        await fs.writeFile(file.absolutePath, file.content, "utf8");
      }

      return JSON.stringify({
        success: true,
        totalRequested: files.length,
        totalUpdated: validatedFiles.length,
        files: validatedFiles.map((file) => ({
          path: file.path,
          success: true,
        })),
      });
    } catch (error) {
      const writeError = error instanceof Error ? error.message : "Failed to update files.";

      const rollbackErrors: string[] = [];

      // Restore files in reverse order.
      for (const file of [...attemptedFiles].reverse()) {
        try {
          await fs.writeFile(file.absolutePath, file.originalContent);
        } catch (rollbackError) {
          rollbackErrors.push(
            `${file.path}: ${
              rollbackError instanceof Error ? rollbackError.message : "Unknown rollback error"
            }`,
          );
        }
      }

      const rollbackSucceeded = rollbackErrors.length === 0;

      return JSON.stringify({
        success: false,
        totalRequested: files.length,
        totalUpdated: 0,
        error: writeError,
        rollbackSucceeded,
        rollbackErrors,
        files: validatedFiles.map((file) => ({
          path: file.path,
          success: false,
          error: rollbackSucceeded
            ? "Update failed; original contents restored."
            : "Update failed; rollback was incomplete. Manual recovery may be required.",
        })),
      });
    }
  },
  {
    name: "update_files",
    description:
      "Update multiple existing Git-tracked portfolio files using their complete new contents. Validates the entire batch before writing and attempts to restore original contents if a write fails. Only call after inspection is complete. Does not commit, push, or create a pull request.",
    schema: updateFilesSchema,
  },
);
