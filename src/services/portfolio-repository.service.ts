import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

const WORKSPACE_PATH = path.resolve(process.cwd(), "workspaces");
const REPOSITORY_PATH = path.join(WORKSPACE_PATH, "portfolio");

function getRepositoryConfig() {
  const repositoryUrl = process.env.PORTFOLIO_REPO_URL;
  const githubToken = process.env.GITHUB_TOKEN;

  if (!repositoryUrl) {
    throw new Error("PORTFOLIO_REPO_URL is not configured.");
  }

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is not configured.");
  }

  const parsedUrl = new URL(repositoryUrl);

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error("PORTFOLIO_REPO_URL must be a valid HTTPS GitHub URL.");
  }

  return { repositoryUrl, githubToken };
}

async function runGit(args: string[], cwd?: string, githubToken?: string) {
  const env = { ...process.env };

  if (githubToken) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(
      `x-access-token:${githubToken}`,
    ).toString("base64")}`;
  }

  return execFileAsync("git", args, {
    cwd,
    env,
    timeout: 120_000,
    maxBuffer: 5 * 1024 * 1024,
  });
}

export async function ensurePortfolioRepository(): Promise<string> {
  const { repositoryUrl, githubToken } = getRepositoryConfig();

  await fs.mkdir(WORKSPACE_PATH, { recursive: true });

  try {
    await fs.access(path.join(REPOSITORY_PATH, ".git"));
  } catch {
    await fs.rm(REPOSITORY_PATH, { recursive: true, force: true });

    await runGit(["clone", "--", repositoryUrl, REPOSITORY_PATH], WORKSPACE_PATH, githubToken);

    return REPOSITORY_PATH;
  }

  const { stdout: remoteUrl } = await runGit(["remote", "get-url", "origin"], REPOSITORY_PATH);

  const normalizeUrl = (value: string) =>
    value
      .trim()
      .replace(/\.git$/, "")
      .replace(/\/$/, "");

  if (normalizeUrl(remoteUrl) !== normalizeUrl(repositoryUrl)) {
    throw new Error("The existing portfolio repository has a different origin URL.");
  }

  const { stdout: status } = await runGit(["status", "--porcelain"], REPOSITORY_PATH);

  if (status.trim()) {
    throw new Error(
      "The portfolio repository contains uncommitted changes. Clean it before continuing.",
    );
  }

  await runGit(["fetch", "origin"], REPOSITORY_PATH, githubToken);
  await runGit(["pull", "--ff-only", "origin", "HEAD"], REPOSITORY_PATH, githubToken);

  return REPOSITORY_PATH;
}
