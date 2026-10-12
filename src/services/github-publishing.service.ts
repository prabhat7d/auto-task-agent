import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPOSITORY_PATH = path.resolve(process.cwd(), "workspaces", "portfolio");
const RESUME_PATH = "public/Prabhat.pdf";
const TARGET_BRANCH = "develop";

interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface PublishResult {
  success: boolean;
  branch: string;
  commit: string;
  pullRequestUrl: string;
  message: string;
}

function getGitHubConfig() {
  const repositoryUrl = process.env.PORTFOLIO_REPO_URL;
  const token = process.env.GITHUB_TOKEN;

  if (!repositoryUrl || !token) {
    throw new Error("PORTFOLIO_REPO_URL and GITHUB_TOKEN must be configured.");
  }

  let url: URL;

  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new Error("PORTFOLIO_REPO_URL is not a valid URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid GitHub repository URL.");
  }

  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length !== 2) {
    throw new Error("Could not determine the GitHub owner and repository.");
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");

  if (!owner || !repo) {
    throw new Error("Could not determine the GitHub owner and repository.");
  }

  return {
    token,
    repository: { owner, repo } satisfies GitHubRepository,
  };
}

function normalizeRepositoryUrl(repositoryUrl: string): string {
  let url: URL;

  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new Error("Git remote URL is invalid.");
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) {
    throw new Error("Git remote must use an HTTPS GitHub URL.");
  }

  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length !== 2) {
    throw new Error("Git remote is not a valid GitHub repository URL.");
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");

  return `${owner}/${repo}`.toLowerCase();
}

async function runGit(args: string[], token?: string) {
  const env = { ...process.env };

  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(
      `x-access-token:${token}`,
    ).toString("base64")}`;
  }

  return execFileAsync("git", args, {
    cwd: REPOSITORY_PATH,
    env,
    timeout: 120_000,
    maxBuffer: 5 * 1024 * 1024,
  });
}

function parseGitPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function validateUpdatedPaths(updatedPaths: string[]): string[] {
  if (updatedPaths.length === 0) {
    throw new Error("There are no updated files to publish.");
  }

  const uniquePaths = [...new Set(updatedPaths)];

  if (uniquePaths.length !== updatedPaths.length) {
    throw new Error("Duplicate updated file paths were provided.");
  }

  for (const filePath of uniquePaths) {
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
  }

  return uniquePaths;
}

async function verifyRepository(expectedRepository: GitHubRepository): Promise<void> {
  await runGit(["rev-parse", "--is-inside-work-tree"]);

  const { stdout } = await runGit(["remote", "get-url", "origin"]);
  const actualRepository = normalizeRepositoryUrl(stdout.trim());
  const expected = `${expectedRepository.owner}/${expectedRepository.repo}`.toLowerCase();

  if (actualRepository !== expected) {
    throw new Error(
      `Repository mismatch. Expected ${expected}, but local origin points to ${actualRepository}.`,
    );
  }
}

async function verifyWorkingTree(updatedPaths: string[]): Promise<void> {
  const allowedPaths = new Set(updatedPaths);

  const { stdout: stagedOutput } = await runGit(["diff", "--cached", "--name-only", "-z"]);

  if (parseGitPaths(stagedOutput).length > 0) {
    throw new Error("The repository contains previously staged changes. Refusing to publish.");
  }

  const { stdout: untrackedOutput } = await runGit([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);

  const untrackedPaths = parseGitPaths(untrackedOutput);
  const unexpectedUntrackedPaths = untrackedPaths.filter((filePath) => !allowedPaths.has(filePath));

  if (unexpectedUntrackedPaths.length > 0) {
    throw new Error(
      `The repository contains unexpected untracked files. Refusing to publish: ${unexpectedUntrackedPaths.join(", ")}`,
    );
  }

  const { stdout: changedOutput } = await runGit(["diff", "--name-only", "-z"]);
  const changedPaths = parseGitPaths(changedOutput);
  const intendedUntrackedPaths = untrackedPaths.filter((filePath) => allowedPaths.has(filePath));

  if (changedPaths.length === 0 && intendedUntrackedPaths.length === 0) {
    throw new Error("No actual file changes were found to publish.");
  }

  const unexpectedPaths = changedPaths.filter((filePath) => !allowedPaths.has(filePath));

  if (unexpectedPaths.length > 0) {
    throw new Error(
      `Unexpected modified files detected. Refusing to publish: ${unexpectedPaths.join(", ")}`,
    );
  }

  const { stdout: deletedOutput } = await runGit(["diff", "--name-only", "--diff-filter=D", "-z"]);
  const deletedPaths = parseGitPaths(deletedOutput);

  if (deletedPaths.length > 0) {
    throw new Error(`Deleted files detected. Refusing to publish: ${deletedPaths.join(", ")}`);
  }
}

export async function publishPortfolioChanges(
  updatedPaths: string[],
  resumeBuffer: Buffer,
): Promise<PublishResult> {
  const validatedInputPaths = validateUpdatedPaths(updatedPaths);

  // Always publish the uploaded resume with the portfolio updates.
  const pathsToPublish = [...new Set([...validatedInputPaths, RESUME_PATH])];
  const safeUpdatedPaths = validateUpdatedPaths(pathsToPublish);

  const { token, repository } = getGitHubConfig();

  await verifyRepository(repository);

  // Make sure the target branch exists remotely.
  await runGit(
    ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${TARGET_BRANCH}`],
    token,
  );

  // Validate the current working tree before preserving the intended file contents.
  await verifyWorkingTree(safeUpdatedPaths);

  // Preserve the approved updated files before switching to the latest develop.
  // This prevents checkout/reset from losing CareerSync's generated file updates.
  const preservedFiles = new Map<string, Buffer>();

  for (const filePath of safeUpdatedPaths) {
    if (filePath === RESUME_PATH) {
      preservedFiles.set(filePath, resumeBuffer);
      continue;
    }

    const absolutePath = path.resolve(REPOSITORY_PATH, filePath);
    const relativePath = path.relative(REPOSITORY_PATH, absolutePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`File is outside the portfolio repository: ${filePath}`);
    }

    try {
      preservedFiles.set(filePath, await fs.readFile(absolutePath));
    } catch (error) {
      throw new Error(
        `Could not preserve updated file ${filePath}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  // Start from the latest remote develop. Approved file contents are preserved above.
  await runGit(["fetch", "origin", TARGET_BRANCH], token);
  await runGit(["checkout", "-f", "-B", TARGET_BRANCH, `origin/${TARGET_BRANCH}`]);

  // Restore the CareerSync-generated contents and replace the resume with the upload.
  for (const [filePath, contents] of preservedFiles) {
    const absolutePath = path.resolve(REPOSITORY_PATH, filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents);
  }

  // Ensure only the approved portfolio files and resume are changed.
  await verifyWorkingTree(safeUpdatedPaths);

  await runGit(["add", "--", ...safeUpdatedPaths]);

  const { stdout: stagedOutput } = await runGit(["diff", "--cached", "--name-only", "-z"]);
  const stagedPaths = parseGitPaths(stagedOutput);

  if (stagedPaths.length === 0) {
    throw new Error("No changes were staged for publishing.");
  }

  const allowedPaths = new Set(safeUpdatedPaths);
  const unexpectedStagedPaths = stagedPaths.filter((filePath) => !allowedPaths.has(filePath));

  if (unexpectedStagedPaths.length > 0) {
    throw new Error(`Unexpected staged files detected: ${unexpectedStagedPaths.join(", ")}`);
  }

  await runGit([
    "-c",
    "user.name=Auto Task Agent",
    "-c",
    "user.email=auto-task-agent@users.noreply.github.com",
    "commit",
    "-m",
    "chore(portfolio): sync content with updated resume",
  ]);

  const { stdout: commitOutput } = await runGit(["rev-parse", "--short", "HEAD"]);
  const commit = commitOutput.trim();

  try {
    // Push directly to develop. This does not create a feature branch or pull request.
    await runGit(["push", "origin", TARGET_BRANCH], token);
  } catch (error) {
    throw new Error(
      `Failed to push to ${TARGET_BRANCH}. Local commit ${commit} may need recovery. ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }

  return {
    success: true,
    branch: TARGET_BRANCH,
    commit,
    pullRequestUrl: "",
    message: "Portfolio changes and updated resume pushed directly to develop.",
  };
}
