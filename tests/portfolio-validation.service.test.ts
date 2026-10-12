import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let validatePortfolio:
  typeof import("../src/services/portfolio-validation.service.js")["validatePortfolio"];

let tempRoot: string;
let repositoryPath: string;
let originalCwd: string;

function runGit(args: string[]) {
  execFileSync("git", args, {
    cwd: repositoryPath,
    stdio: "pipe",
  });
}

async function writePackageJson(packageJson: Record<string, unknown>) {
  await fs.writeFile(
    path.join(repositoryPath, "package.json"),
    JSON.stringify(packageJson, null, 2),
    "utf8",
  );
}

describe("portfolio validation service", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();

    originalCwd = process.cwd();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-validation-"));
    repositoryPath = path.join(tempRoot, "workspaces", "portfolio");

    await fs.mkdir(path.join(repositoryPath, "src"), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(repositoryPath, "src", "page.tsx"),
      "export default function Page() { return <main>Hello</main>; }\n",
      "utf8",
    );

    await writePackageJson({
      name: "test-portfolio",
      scripts: {},
    });

    runGit(["init"]);
    runGit(["config", "user.name", "Portfolio Validation Tests"]);
    runGit(["config", "user.email", "portfolio-validation@example.com"]);
    runGit(["add", "."]);
    runGit(["commit", "-m", "Initial portfolio"]);

    vi.spyOn(process, "cwd").mockReturnValue(tempRoot);

    // Load the service after the test's cwd is configured. Use real Git
    // commands instead of mocking execFile, which caused the test timeouts.
    vi.resetModules();
    ({ validatePortfolio } = await import(
      "../src/services/portfolio-validation.service.js"
    ));
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (originalCwd) {
      process.chdir(originalCwd);
    }

    if (tempRoot) {
      await fs.rm(tempRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it("skips the build when package.json has no build script", async () => {
    await writePackageJson({
      name: "test-portfolio",
      scripts: {},
    });

    const result = await validatePortfolio();

    expect(result.success).toBe(true);
    expect(result.buildStatus).toBe("skipped");
    expect(result.checks.build).toBeNull();
    expect(result.messages.some((message) => message.toLowerCase().includes("build"))).toBe(true);
  });

  it("skips the build when node_modules is missing", async () => {
    await writePackageJson({
      name: "test-portfolio",
      scripts: {
        build: "vite build",
      },
    });

    const result = await validatePortfolio();

    expect(result.success).toBe(true);
    expect(result.buildStatus).toBe("skipped");
    expect(result.checks.build).toBeNull();
  });

  it("fails when the repository has Git whitespace errors", async () => {
    const filePath = path.join(repositoryPath, "src", "page.tsx");

    await fs.writeFile(
      filePath,
      "export default function Page() { return <main>Hello</main>; }   \n",
      "utf8",
    );

    const result = await validatePortfolio();

    expect(result.success).toBe(false);
    expect(result.checks.gitDiff).toBe(false);
    expect(result.buildStatus).toBe("skipped");
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("passes Git validation when there are no whitespace errors", async () => {
    const result = await validatePortfolio();

    expect(result.checks.gitDiff).toBe(true);
    expect(result.success).toBe(true);
  });

  it("reports a missing Git repository as a validation failure", async () => {
    await fs.rm(path.join(repositoryPath, ".git"), {
      recursive: true,
      force: true,
    });

    const result = await validatePortfolio();

    expect(result.success).toBe(false);
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
