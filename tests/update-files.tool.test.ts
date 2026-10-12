import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { updateFiles } from "../src/tools/update-files.tool.js";

interface UpdateToolResponse {
  success: boolean;
  totalRequested: number;
  totalUpdated: number;
  error?: string;
  rollbackSucceeded?: boolean;
  rollbackErrors?: string[];
  files: Array<{
    path: string;
    success: boolean;
    error?: string;
  }>;
}

interface FileUpdate {
  path: string;
  content: string;
}

let tempRoot: string;
let repositoryPath: string;

function runGit(args: string[]) {
  execFileSync("git", args, {
    cwd: repositoryPath,
    stdio: "pipe",
  });
}

async function invokeUpdateFiles(files: FileUpdate[]): Promise<UpdateToolResponse> {
  const result = await updateFiles.invoke({ files });

  return JSON.parse(String(result)) as UpdateToolResponse;
}

async function readRepositoryFile(filePath: string): Promise<string> {
  return fs.readFile(path.join(repositoryPath, filePath), "utf8");
}

describe("updateFiles tool", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "career-sync-tests-"));

    repositoryPath = path.join(tempRoot, "workspaces", "portfolio");

    await fs.mkdir(path.join(repositoryPath, "src"), {
      recursive: true,
    });

    // Create initial tracked files.
    await fs.writeFile(
      path.join(repositoryPath, "src", "page.tsx"),
      "export default function Page() { return <div>Original page</div>; }\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(repositoryPath, "src", "style.css"),
      "body { margin: 0; }\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(repositoryPath, "package-lock.json"),
      '{"name":"test-portfolio"}\n',
      "utf8",
    );

    // Initialize a temporary Git repository.
    runGit(["init"]);
    runGit(["config", "user.name", "CareerSync Tests"]);
    runGit(["config", "user.email", "career-sync-tests@example.com"]);
    runGit(["add", "src/page.tsx", "src/style.css", "package-lock.json"]);
    runGit(["commit", "-m", "Initial test files"]);

    // Create an existing but untracked file.
    await fs.writeFile(
      path.join(repositoryPath, "src", "untracked.tsx"),
      "export const original = true;\n",
      "utf8",
    );

    // The tool resolves the portfolio at:
    // process.cwd()/workspaces/portfolio
    vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (tempRoot) {
      await fs.rm(tempRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it("updates an existing Git-tracked file successfully", async () => {
    const newContent = "export default function Page() { return <div>Updated page</div>; }\n";

    const result = await invokeUpdateFiles([
      {
        path: "src/page.tsx",
        content: newContent,
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.totalRequested).toBe(1);
    expect(result.totalUpdated).toBe(1);

    expect(result.files).toEqual([
      {
        path: "src/page.tsx",
        success: true,
      },
    ]);

    await expect(readRepositoryFile("src/page.tsx")).resolves.toBe(newContent);
  });

  it("updates multiple tracked files successfully", async () => {
    const newPage = "<main>Updated portfolio</main>\n";
    const newStyles = "body { margin: 10px; }\n";

    const result = await invokeUpdateFiles([
      {
        path: "src/page.tsx",
        content: newPage,
      },
      {
        path: "src/style.css",
        content: newStyles,
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.totalRequested).toBe(2);
    expect(result.totalUpdated).toBe(2);

    await expect(readRepositoryFile("src/page.tsx")).resolves.toBe(newPage);
    await expect(readRepositoryFile("src/style.css")).resolves.toBe(newStyles);
  });

  it("rejects an entire batch if one path is invalid", async () => {
    const originalPage = await readRepositoryFile("src/page.tsx");

    const result = await invokeUpdateFiles([
      {
        path: "src/page.tsx",
        content: "<main>Should not be written</main>\n",
      },
      {
        path: "../outside.tsx",
        content: "<main>Invalid path</main>\n",
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.totalUpdated).toBe(0);

    // The valid file must remain unchanged because the batch was rejected.
    await expect(readRepositoryFile("src/page.tsx")).resolves.toBe(originalPage);

    expect(result.files.some((file) => file.error?.includes("Invalid"))).toBe(true);
  });

  it("rejects files that are not tracked by Git", async () => {
    const originalContent = await readRepositoryFile("src/untracked.tsx");

    const result = await invokeUpdateFiles([
      {
        path: "src/untracked.tsx",
        content: "export const updated = true;\n",
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.totalUpdated).toBe(0);

    expect(result.files[0].error).toContain("Git-tracked");

    await expect(readRepositoryFile("src/untracked.tsx")).resolves.toBe(originalContent);
  });

  it("rejects protected files such as package-lock.json", async () => {
    const originalContent = await readRepositoryFile("package-lock.json");

    const result = await invokeUpdateFiles([
      {
        path: "package-lock.json",
        content: '{"name":"modified"}\n',
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.totalUpdated).toBe(0);
    expect(result.files[0].error).toContain("not allowed");

    await expect(readRepositoryFile("package-lock.json")).resolves.toBe(originalContent);
  });

  it("rejects duplicate paths in the same batch", async () => {
    const originalContent = await readRepositoryFile("src/page.tsx");

    const result = await invokeUpdateFiles([
      {
        path: "src/page.tsx",
        content: "<main>First version</main>\n",
      },
      {
        path: "src/page.tsx",
        content: "<main>Second version</main>\n",
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.totalUpdated).toBe(0);

    expect(result.files.every((file) => file.error?.includes("Duplicate file paths"))).toBe(true);

    await expect(readRepositoryFile("src/page.tsx")).resolves.toBe(originalContent);
  });

  it("rejects directory traversal attempts", async () => {
    const result = await invokeUpdateFiles([
      {
        path: "../../outside.tsx",
        content: "malicious content",
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.totalUpdated).toBe(0);
    expect(result.files[0].error).toContain("Invalid repository-relative path");
  });

  it("rejects unsupported file extensions", async () => {
    // Create and track a file with an unsupported extension.
    await fs.writeFile(
      path.join(repositoryPath, "src", "config.php"),
      "<?php echo 'original';\n",
      "utf8",
    );

    runGit(["add", "src/config.php"]);
    runGit(["commit", "-m", "Add unsupported file fixture"]);

    const result = await invokeUpdateFiles([
      {
        path: "src/config.php",
        content: "<?php echo 'updated';\n",
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.totalUpdated).toBe(0);
    expect(result.files[0].error).toContain("Unsupported file type");
  });

  it("rejects files larger than 100 KB", async () => {
    const result = await invokeUpdateFiles([
      {
        path: "src/page.tsx",
        content: "x".repeat(100 * 1024 + 1),
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.totalUpdated).toBe(0);
    expect(result.files[0].error).toContain("100 KB");
  });

  it("restores original contents when a write fails", async () => {
    const originalPage = await readRepositoryFile("src/page.tsx");
    const originalStyles = await readRepositoryFile("src/style.css");

    const originalWriteFile = fs.writeFile.bind(fs) as (...args: any[]) => Promise<void>;

    const failingPath = path.join(repositoryPath, "src", "style.css");
    let failureTriggered = false;

    vi.spyOn(fs, "writeFile").mockImplementation(async (...args: any[]) => {
      const targetPath = String(args[0]);

      // Allow the first file to be updated, then fail on the second file.
      // The subsequent rollback writes are allowed to succeed.
      if (path.resolve(targetPath) === failingPath && !failureTriggered) {
        failureTriggered = true;
        throw new Error("Simulated write failure");
      }

      return originalWriteFile(...args);
    });

    const result = await invokeUpdateFiles([
      {
        path: "src/page.tsx",
        content: "<main>Changed page</main>\n",
      },
      {
        path: "src/style.css",
        content: "body { color: red; }\n",
      },
    ]);

    expect(failureTriggered).toBe(true);
    expect(result.success).toBe(false);
    expect(result.totalUpdated).toBe(0);
    expect(result.error).toContain("Simulated write failure");
    expect(result.rollbackSucceeded).toBe(true);
    expect(result.rollbackErrors).toEqual([]);

    // Both files should contain their original contents after rollback.
    await expect(readRepositoryFile("src/page.tsx")).resolves.toBe(originalPage);
    await expect(readRepositoryFile("src/style.css")).resolves.toBe(originalStyles);
  });
});
