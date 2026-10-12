import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPOSITORY_PATH = path.resolve(process.cwd(), "workspaces", "portfolio");

export type BuildStatus = "passed" | "failed" | "skipped";

export interface PortfolioValidationResult {
  success: boolean;

  checks: {
    gitDiff: boolean;
    build: boolean | null;
  };

  buildStatus: BuildStatus;

  messages: string[];
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown error.";
  }

  const processError = error as Error & {
    stderr?: string;
    stdout?: string;
  };

  const details = [processError.stderr, processError.stdout]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .trim();

  return details || error.message;
}

export async function validatePortfolio(): Promise<PortfolioValidationResult> {
  const messages: string[] = [];

  // 1. Verify that the repository exists.
  try {
    await fs.access(path.join(REPOSITORY_PATH, ".git"));
  } catch {
    return {
      success: false,
      checks: {
        gitDiff: false,
        build: null,
      },
      buildStatus: "skipped",
      messages: ["Portfolio Git repository was not found."],
    };
  }

  // 2. Check whitespace errors in the changes.
  try {
    await execFileAsync("git", ["diff", "--check"], {
      cwd: REPOSITORY_PATH,
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    messages.push("Git diff check passed.");
  } catch (error) {
    return {
      success: false,
      checks: {
        gitDiff: false,
        build: null,
      },
      buildStatus: "skipped",
      messages: ["Git diff check failed.", getErrorMessage(error)],
    };
  }

  // 3. Read package.json.
  const packageJsonPath = path.join(REPOSITORY_PATH, "package.json");

  let packageJson: {
    scripts?: Record<string, string>;
  };

  try {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
  } catch (error) {
    return {
      success: false,
      checks: {
        gitDiff: true,
        build: null,
      },
      buildStatus: "skipped",
      messages: [...messages, "Could not read the portfolio package.json.", getErrorMessage(error)],
    };
  }

  // 4. Check whether a build script exists.
  if (!packageJson.scripts?.build) {
    messages.push("Build validation skipped: no build script exists.");

    return {
      success: true,
      checks: {
        gitDiff: true,
        build: null,
      },
      buildStatus: "skipped",
      messages,
    };
  }

  // 5. Check whether dependencies are installed.
  try {
    await fs.access(path.join(REPOSITORY_PATH, "node_modules"));
  } catch {
    messages.push(
      "Build validation skipped: node_modules is missing. Dependencies were not installed automatically.",
    );

    return {
      success: true,
      checks: {
        gitDiff: true,
        build: null,
      },
      buildStatus: "skipped",
      messages,
    };
  }

  // 6. Execute the build.
  try {
    await execFileAsync("npm", ["run", "build"], {
      cwd: REPOSITORY_PATH,
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    messages.push("Portfolio build passed.");

    return {
      success: true,
      checks: {
        gitDiff: true,
        build: true,
      },
      buildStatus: "passed",
      messages,
    };
  } catch (error) {
    messages.push("Portfolio build failed.");
    messages.push(getErrorMessage(error));

    return {
      success: false,
      checks: {
        gitDiff: true,
        build: false,
      },
      buildStatus: "failed",
      messages,
    };
  }
}
