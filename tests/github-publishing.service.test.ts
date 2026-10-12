import fs from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { execFileSync } from "node:child_process";

import { promisify } from "node:util";



import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";



const mocked = vi.hoisted(() => ({

  fetch: vi.fn(),

  execFile: vi.fn(),

}));



vi.mock("node:child_process", async (importOriginal) => {

  const actual = await importOriginal<typeof import("node:child_process")>();

  const { promisify } = await import("node:util");



  const realExecFileAsync = promisify(actual.execFile);



  const mockedExecFile = vi.fn();



  Object.defineProperty(mockedExecFile, promisify.custom, {

    value: async (command: string, args: string[], options: Record<string, unknown>) => {

      // Prevent real network operations during tests.

      if (command === "git" && (args[0] === "fetch" || args[0] === "push")) {

        return {

          stdout: "",

          stderr: "",

        };

      }



      return realExecFileAsync(command, args, options as Parameters<typeof actual.execFile>[2]);

    },

  });



  mocked.execFile = mockedExecFile;



  return {

    ...actual,

    execFile: mockedExecFile,

  };

});



let publishPortfolioChanges:
  typeof import("../src/services/github-publishing.service.js")["publishPortfolioChanges"];



const REPOSITORY_URL = "https://github.com/acme/portfolio.git";

const GITHUB_TOKEN = "test-github-token";



let tempRoot: string;

let repositoryPath: string;

let originalCwd: string;



function runGit(args: string[]) {

  execFileSync("git", args, {

    cwd: repositoryPath,

    stdio: "pipe",

  });

}



async function writeRepositoryFile(filePath: string, content: string): Promise<void> {

  await fs.writeFile(path.join(repositoryPath, filePath), content, "utf8");

}



function mockGitHubApi(options?: {

  existingPullRequest?: boolean;

  failPullRequestCreation?: boolean;

}) {

  mocked.fetch.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {

    const url = String(input);

    const method = init?.method ?? "GET";



    // Repository details endpoint.

    if (url === "https://api.github.com/repos/acme/portfolio") {

      return Response.json({

        default_branch: "main",

      });

    }



    // Existing pull requests endpoint.

    if (url.startsWith("https://api.github.com/repos/acme/portfolio/pulls?") && method === "GET") {

      if (options?.existingPullRequest) {

        return Response.json([

          {

            html_url: "https://github.com/acme/portfolio/pull/99",

          },

        ]);

      }



      return Response.json([]);

    }



    // Create pull request endpoint.

    if (url === "https://api.github.com/repos/acme/portfolio/pulls" && method === "POST") {

      if (options?.failPullRequestCreation) {

        return Response.json(

          {

            message: "Pull request creation failed",

          },

          {

            status: 422,

          },

        );

      }



      return Response.json({

        html_url: "https://github.com/acme/portfolio/pull/123",

      });

    }



    return Response.json(

      {

        message: `Unexpected GitHub API request: ${method} ${url}`,

      },

      {

        status: 404,

      },

    );

  });

}



describe("GitHub publishing service", () => {

  beforeEach(async () => {

    vi.clearAllMocks();



    originalCwd = process.cwd();



    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "github-publishing-tests-"));



    repositoryPath = path.join(tempRoot, "workspaces", "portfolio");



    await fs.mkdir(path.join(repositoryPath, "src"), {

      recursive: true,

    });



    await writeRepositoryFile(

      "src/page.tsx",

      "export default function Page() { return <main>Original</main>; }\n",

    );



    await writeRepositoryFile("src/style.css", "body { margin: 0; }\n");



    // Initialize a real temporary Git repository.

    runGit(["init", "-b", "main"]);

    runGit(["config", "user.name", "Publishing Tests"]);

    runGit(["config", "user.email", "publishing-tests@example.com"]);



    runGit(["add", "."]);

    runGit(["commit", "-m", "Initial portfolio"]);



    // Configure the expected GitHub remote.

    runGit(["remote", "add", "origin", REPOSITORY_URL]);



    // Create the remote-tracking reference needed by the branch checkout.

    runGit(["update-ref", "refs/remotes/origin/main", "HEAD"]);



    process.chdir(tempRoot);

    // Resolve the service's repository path from this test's isolated directory.
    vi.resetModules();
    ({ publishPortfolioChanges } = await import(
      "../src/services/github-publishing.service.js"
    ));

    vi.stubEnv("PORTFOLIO_REPO_URL", REPOSITORY_URL);

    vi.stubEnv("GITHUB_TOKEN", GITHUB_TOKEN);



    vi.stubGlobal("fetch", mocked.fetch);



    mockGitHubApi();

  });



  afterEach(async () => {

    process.chdir(originalCwd);



    vi.unstubAllEnvs();

    vi.unstubAllGlobals();

    vi.restoreAllMocks();



    if (tempRoot) {

      await fs.rm(tempRoot, {

        recursive: true,

        force: true,

      });

    }

  });



  it("rejects an invalid GitHub repository URL", async () => {

    vi.stubEnv("PORTFOLIO_REPO_URL", "https://example.com/acme/portfolio.git");



    await writeRepositoryFile("src/page.tsx", "<main>Updated portfolio</main>\n");



    await expect(publishPortfolioChanges(["src/page.tsx"])).rejects.toThrow(

      "Invalid GitHub repository URL.",

    );



    expect(mocked.fetch).not.toHaveBeenCalled();

  });



  it("rejects missing GitHub configuration", async () => {

    vi.stubEnv("GITHUB_TOKEN", "");



    await expect(publishPortfolioChanges(["src/page.tsx"])).rejects.toThrow(

      "PORTFOLIO_REPO_URL and GITHUB_TOKEN must be configured.",

    );



    expect(mocked.fetch).not.toHaveBeenCalled();

  });



  it("rejects an empty list of updated paths", async () => {

    await expect(publishPortfolioChanges([])).rejects.toThrow(

      "There are no updated files to publish.",

    );



    expect(mocked.fetch).not.toHaveBeenCalled();

  });



  it("rejects duplicate updated paths", async () => {

    await expect(publishPortfolioChanges(["src/page.tsx", "src/page.tsx"])).rejects.toThrow(

      "Duplicate updated file paths were provided.",

    );



    expect(mocked.fetch).not.toHaveBeenCalled();

  });



  it("rejects directory traversal paths", async () => {

    await expect(publishPortfolioChanges(["../outside.tsx"])).rejects.toThrow(

      "Invalid repository-relative path",

    );



    expect(mocked.fetch).not.toHaveBeenCalled();

  });



  it("rejects a Git remote that points to another repository", async () => {

    runGit(["remote", "set-url", "origin", "https://github.com/another-owner/another-repo.git"]);



    await writeRepositoryFile("src/page.tsx", "<main>Updated portfolio</main>\n");



    await expect(publishPortfolioChanges(["src/page.tsx"])).rejects.toThrow("Repository mismatch.");



    expect(mocked.fetch).not.toHaveBeenCalled();

  });



  it("rejects changes to files that were not approved for publishing", async () => {

    await writeRepositoryFile("src/page.tsx", "<main>Updated portfolio</main>\n");



    await writeRepositoryFile("src/style.css", "body { color: red; }\n");



    await expect(publishPortfolioChanges(["src/page.tsx"])).rejects.toThrow(

      "Unexpected modified files detected.",

    );



    // Only the repository-details API call should have happened.

    expect(mocked.fetch).toHaveBeenCalledOnce();

  });



  it("rejects a repository containing untracked files", async () => {

    await writeRepositoryFile("src/page.tsx", "<main>Updated portfolio</main>\n");



    await writeRepositoryFile("src/unexpected.tsx", "<main>Unexpected file</main>\n");



    await expect(publishPortfolioChanges(["src/page.tsx"])).rejects.toThrow("untracked files");



    expect(mocked.fetch).toHaveBeenCalledOnce();

  });



  it("creates a branch and pull request without automatically merging", async () => {

    const updatedContent = "<main>Updated portfolio</main>\n";



    await writeRepositoryFile("src/page.tsx", updatedContent);



    const result = await publishPortfolioChanges(["src/page.tsx"]);



    expect(result.success).toBe(true);

    expect(result.branch).toMatch(/^career-sync\/update-\d+$/);

    expect(result.commit).toBeTruthy();



    expect(result.pullRequestUrl).toBe("https://github.com/acme/portfolio/pull/123");



    expect(result.message).toContain("pull request created");



    // Verify the approved file was committed to the new local branch.

    const branch = execFileSync("git", ["branch", "--show-current"], {

      cwd: repositoryPath,

      encoding: "utf8",

    }).trim();



    expect(branch).toBe(result.branch);



    const committedContent = execFileSync("git", ["show", "HEAD:src/page.tsx"], {

      cwd: repositoryPath,

      encoding: "utf8",

    });



    expect(committedContent).toBe(updatedContent);



    // Verify the GitHub API was asked to create a PR.

    const createPullRequestCall = mocked.fetch.mock.calls.find(

      ([url, init]) =>

        String(url) === "https://api.github.com/repos/acme/portfolio/pulls" &&

        init?.method === "POST",

    );



    expect(createPullRequestCall).toBeDefined();



    const requestBody = JSON.parse(String(createPullRequestCall?.[1]?.body));



    expect(requestBody.title).toBe("Update portfolio based on latest resume");



    expect(requestBody.base).toBe("main");

    expect(requestBody.head).toBe(result.branch);

    expect(requestBody.body).toContain("Please review the changes before merging.");



    // The service must not call a merge endpoint.

    const mergeCalls = mocked.fetch.mock.calls.filter(([url]) =>

      /\/pulls\/\d+\/merge(?:\?|$)/.test(String(url)),

    );



    expect(mergeCalls).toHaveLength(0);

  });



  it("returns an existing pull request URL when one is found", async () => {

    mockGitHubApi({

      existingPullRequest: true,

    });



    await writeRepositoryFile("src/page.tsx", "<main>Updated portfolio</main>\n");



    const result = await publishPortfolioChanges(["src/page.tsx"]);



    expect(result.success).toBe(true);



    expect(result.pullRequestUrl).toBe("https://github.com/acme/portfolio/pull/99");



    expect(result.message).toContain("existing pull request");



    const createPullRequestCalls = mocked.fetch.mock.calls.filter(

      ([url, init]) =>

        String(url) === "https://api.github.com/repos/acme/portfolio/pulls" &&

        init?.method === "POST",

    );



    expect(createPullRequestCalls).toHaveLength(0);

  });



  it("reports when GitHub rejects pull request creation", async () => {

    mockGitHubApi({

      failPullRequestCreation: true,

    });



    await writeRepositoryFile("src/page.tsx", "<main>Updated portfolio</main>\n");



    await expect(publishPortfolioChanges(["src/page.tsx"])).rejects.toThrow(

      "was pushed successfully, but PR creation failed.",

    );

  });

});
