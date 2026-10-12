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

export const readFiles = tool(
  async ({ paths }) => {
    if (paths.length > MAX_FILES_PER_BATCH) {
      return JSON.stringify({
        success: false,
        error: `Maximum ${MAX_FILES_PER_BATCH} files are allowed per batch.`,
      });
    }

    const repositoryPath = await ensurePortfolioRepository();

    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: repositoryPath,
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const trackedFiles = new Set(
      stdout
        .split("\n")
        .map((file) => file.trim())
        .filter(Boolean),
    );

    const uniquePaths = [...new Set(paths)];
    const results: Array<{
      path: string;
      success: boolean;
      content?: string;
      error?: string;
    }> = [];

    let totalSize = 0;

    for (const filePath of uniquePaths) {
      const normalizedPath = path.posix.normalize(filePath);
      const fileName = path.posix.basename(normalizedPath);

      if (
        path.posix.isAbsolute(filePath) ||
        normalizedPath === ".." ||
        normalizedPath.startsWith("../") ||
        normalizedPath !== filePath ||
        filePath.includes("\\")
      ) {
        results.push({
          path: filePath,
          success: false,
          error: "Invalid repository-relative path.",
        });

        continue;
      }

      if (!trackedFiles.has(filePath)) {
        results.push({
          path: filePath,
          success: false,
          error: "File is not tracked by Git.",
        });

        continue;
      }

      if (
        BLOCKED_FILES.has(fileName) ||
        fileName.startsWith(".env.") ||
        fileName.endsWith(".pem") ||
        fileName.endsWith(".key")
      ) {
        results.push({
          path: filePath,
          success: false,
          error: "Reading this file is not allowed.",
        });

        continue;
      }

      const extension = path.posix.extname(filePath).toLowerCase();

      if (!ALLOWED_EXTENSIONS.has(extension)) {
        results.push({
          path: filePath,
          success: false,
          error: `Unsupported file type: ${extension || "no extension"}.`,
        });

        continue;
      }

      const absolutePath = path.resolve(repositoryPath, filePath);
      const relativePath = path.relative(repositoryPath, absolutePath);

      if (
        relativePath.startsWith(`..${path.sep}`) ||
        relativePath === ".." ||
        path.isAbsolute(relativePath)
      ) {
        results.push({
          path: filePath,
          success: false,
          error: "Path is outside the repository.",
        });

        continue;
      }

      try {
        const stats = await fs.stat(absolutePath);

        if (!stats.isFile()) {
          throw new Error("Path is not a regular file.");
        }

        if (stats.size > MAX_FILE_SIZE) {
          throw new Error("File exceeds the 100 KB size limit.");
        }

        if (totalSize + stats.size > MAX_TOTAL_SIZE) {
          results.push({
            path: filePath,
            success: false,
            error: "Batch has reached its 500 KB total size limit.",
          });

          continue;
        }

        const content = await fs.readFile(absolutePath, "utf8");

        totalSize += stats.size;

        results.push({
          path: filePath,
          success: true,
          content,
        });
      } catch (error) {
        results.push({
          path: filePath,
          success: false,
          error: error instanceof Error ? error.message : "Failed to read file.",
        });
      }
    }

    return JSON.stringify({
      success: true,
      totalRequested: uniquePaths.length,
      totalRead: results.filter((file) => file.success).length,
      files: results,
    });
  },
  {
    name: "read_files",
    description:
      "Read multiple tracked text files from the portfolio repository in one batch. Use repository-relative paths returned by get_portfolio_files. Returns each file's content or an error. Does not modify files.",
    schema: z.object({
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_FILES_PER_BATCH)
        .describe("Repository-relative paths of the files to read."),
    }),
  },
);
