import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ensurePortfolioRepository } from "../services/portfolio-repository.service.js";

const execFileAsync = promisify(execFile);

const IGNORED_PATHS = ["node_modules/", "dist/", "build/", "coverage/", ".next/", ".vite/"];

export const getPortfolioFiles = tool(
  async () => {
    const repositoryPath = await ensurePortfolioRepository();

    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: repositoryPath,
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const files = stdout
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean)
      .filter(
        (file) =>
          !IGNORED_PATHS.some((ignored) => file.startsWith(ignored)) && !file.startsWith(".git/"),
      );

    return JSON.stringify({
      success: true,
      totalFiles: files.length,
      files,
    });
  },
  {
    name: "get_portfolio_files",
    description:
      "Retrieve the tracked file paths of the portfolio repository. Does not read file contents. Use these paths to decide which files need inspection.",
    schema: z.object({}),
  },
);
