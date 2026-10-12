import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({

  analyzeInitialContext: vi.fn(),

  llmInvoke: vi.fn(),

  readFilesInvoke: vi.fn(),

  updateFilesInvoke: vi.fn(),

  validatePortfolio: vi.fn(),

  publishPortfolioChanges: vi.fn(),

}));

vi.mock("../src/agents/career-sync/initial-analysis.service.js", () => ({

  analyzeInitialContext: mocks.analyzeInitialContext,

}));

vi.mock("../src/services/llm.service.js", () => ({

  llm: {

    withStructuredOutput: vi.fn(() => ({

      invoke: mocks.llmInvoke,

    })),

  },

}));

vi.mock("../src/tools/read-file.tool.js", () => ({

  readFiles: {

    invoke: mocks.readFilesInvoke,

  },

}));

vi.mock("../src/tools/update-files.tool.js", () => ({

  updateFiles: {

    invoke: mocks.updateFilesInvoke,

  },

}));

vi.mock("../src/services/portfolio-validation.service.js", () => ({

  validatePortfolio: mocks.validatePortfolio,

}));

vi.mock("../src/services/github-publishing.service.js", () => ({

  publishPortfolioChanges: mocks.publishPortfolioChanges,

}));

import {

  initialAnalysisNode,

  readPortfolioFilesNode,

  inspectPortfolioNode,

  updatePortfolioFilesNode,

  validatePortfolioNode,

  publishPortfolioNode,

} from "../src/graph/career-sync.nodes.js";

import type { CareerSyncStateType } from "../src/graph/career-sync.state.js";

function createState(overrides: Partial<CareerSyncStateType> = {}): CareerSyncStateType {

  return {

    context: {

      previousResume: "Previous resume text",

      newResume: "Updated resume text",

      portfolioFiles: [

        "src/app/page.tsx",

        "src/app/projects/page.tsx",

        "src/app/experience/page.tsx",

      ],

      portfolioStructure: "Homepage contains summaries; detailed pages contain full information.",

    },

    initialAnalysis: {

      summary: "Resume changes identified.",

      filesToRead: ["src/app/page.tsx"],

      reasoning: "Inspect the homepage first.",

    },

    stage: "inspecting",

    filesToRead: [],

    readResults: [

      {

        path: "src/app/page.tsx",

        success: true,

        content: "export default function Home() { return <main>Portfolio</main>; }",

      },

    ],

    inspectionRounds: 0,

    filesToUpdate: [],

    updatedPaths: [],

    errors: [],

    pullRequestUrl: null,

    ...overrides,

  } as CareerSyncStateType;

}

let tempRoot: string;

describe("CareerSync workflow nodes", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "career-sync-nodes-"));
    const repositoryPath = path.join(tempRoot, "workspaces", "portfolio");

    await fs.mkdir(path.join(repositoryPath, "src", "app"), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(repositoryPath, "src", "app", "page.tsx"),
      "export default function Home() { return <main>Original</main>; }\n",
      "utf8",
    );

    vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  describe("initialAnalysisNode", () => {

    it("selects files for the initial inspection", async () => {

      const state = createState();

      mocks.analyzeInitialContext.mockResolvedValue({

        summary: "Inspect the homepage and experience page.",

        filesToRead: ["src/app/page.tsx", "src/app/experience/page.tsx"],

        reasoning: "These pages contain the relevant information.",

      });

      const result = await initialAnalysisNode(state);

      expect(result.stage).toBe("reading");

      expect(result.filesToRead).toEqual(["src/app/page.tsx", "src/app/experience/page.tsx"]);

      expect(result.inspectionRounds).toBe(0);

    });

    it("throws when the context is missing", async () => {

      await expect(initialAnalysisNode(createState({ context: null }))).rejects.toThrow(

        "CareerSync context is missing.",

      );

    });

  });

  describe("readPortfolioFilesNode", () => {

    it("reads selected files and enters inspection", async () => {

      const state = createState({

        stage: "reading",

        filesToRead: ["src/app/projects/page.tsx"],

        readResults: [],

      });

      mocks.readFilesInvoke.mockResolvedValue(

        JSON.stringify({

          success: true,

          files: [

            {

              path: "src/app/projects/page.tsx",

              success: true,

              content: "export default function Projects() { return <main />; }",

            },

          ],

        }),

      );

      const result = await readPortfolioFilesNode(state);

      expect(result.stage).toBe("inspecting");

      expect(result.filesToRead).toEqual([]);

      expect(result.readResults).toHaveLength(1);

    });

    it("accumulates previously inspected files", async () => {

      const state = createState({

        stage: "reading",

        filesToRead: ["src/app/projects/page.tsx"],

      });

      mocks.readFilesInvoke.mockResolvedValue(

        JSON.stringify({

          success: true,

          files: [

            {

              path: "src/app/projects/page.tsx",

              success: true,

              content: "Projects page",

            },

          ],

        }),

      );

      const result = await readPortfolioFilesNode(state);

      expect(result.readResults).toHaveLength(2);

      expect(result.readResults?.map((file) => file.path)).toEqual([

        "src/app/page.tsx",

        "src/app/projects/page.tsx",

      ]);

    });

    it("rejects a path that is not in the tracked portfolio file list", async () => {

      const state = createState({

        stage: "reading",

        filesToRead: ["secret.txt"],

      });

      const result = await readPortfolioFilesNode(state);

      expect(result.stage).toBe("failed");

      expect(result.errors?.[0]).toContain("not in the tracked portfolio file list");

      expect(mocks.readFilesInvoke).not.toHaveBeenCalled();

    });

    it("rejects files that have already been inspected", async () => {

      const state = createState({

        stage: "reading",

        filesToRead: ["src/app/page.tsx"],

      });

      const result = await readPortfolioFilesNode(state);

      expect(result.stage).toBe("failed");

      expect(result.errors?.[0]).toContain("already-read file");

      expect(mocks.readFilesInvoke).not.toHaveBeenCalled();

    });

    it("fails when no files were selected", async () => {

      const result = await readPortfolioFilesNode(

        createState({

          stage: "reading",

          filesToRead: [],

        }),

      );

      expect(result.stage).toBe("failed");

      expect(result.errors?.[0]).toContain("No new files");

    });

    it("fails when a file cannot be read", async () => {

      mocks.readFilesInvoke.mockResolvedValue(

        JSON.stringify({

          success: false,

          files: [

            {

              path: "src/app/projects/page.tsx",

              success: false,

              error: "File not found",

            },

          ],

        }),

      );

      const result = await readPortfolioFilesNode(

        createState({

          stage: "reading",

          filesToRead: ["src/app/projects/page.tsx"],

          readResults: [],

        }),

      );

      expect(result.stage).toBe("failed");

      expect(result.errors?.[0]).toContain("File not found");

    });

  });

  describe("inspectPortfolioNode", () => {

    it("requests additional files when more context is needed", async () => {

      mocks.llmInvoke.mockResolvedValue({

        summary: "The homepage references projects that need further inspection.",

        needsMoreFiles: true,

        filesToRead: ["src/app/projects/page.tsx"],

        updates: [],

      });

      const result = await inspectPortfolioNode(

        createState({

          stage: "inspecting",

          inspectionRounds: 1,

        }),

      );

      expect(result.stage).toBe("reading");

      expect(result.filesToRead).toEqual(["src/app/projects/page.tsx"]);

      expect(result.inspectionRounds).toBe(2);

    });

    it("completes when no portfolio changes are needed", async () => {

      mocks.llmInvoke.mockResolvedValue({

        summary: "The portfolio already reflects the updated resume.",

        needsMoreFiles: false,

        filesToRead: [],

        updates: [],

      });

      const result = await inspectPortfolioNode(createState({ stage: "inspecting" }));

      expect(result.stage).toBe("completed");

      expect(result.filesToUpdate).toEqual([]);

    });

    it("returns proposed updates when inspection is complete", async () => {

      mocks.llmInvoke.mockResolvedValue({

        summary: "The homepage needs an updated professional summary.",

        needsMoreFiles: false,

        filesToRead: [],

        updates: [

          {

            path: "src/app/page.tsx",

            content: "export default function Home() { return <main>Updated</main>; }",

          },

        ],

      });

      const result = await inspectPortfolioNode(createState({ stage: "inspecting" }));

      expect(result.stage).toBe("updating");

      expect(result.filesToUpdate).toHaveLength(1);

      expect(result.filesToUpdate?.[0].path).toBe("src/app/page.tsx");

    });

    it("rejects updates to files that were not inspected", async () => {

      mocks.llmInvoke.mockResolvedValue({

        summary: "Update the projects page.",

        needsMoreFiles: false,

        filesToRead: [],

        updates: [

          {

            path: "src/app/projects/page.tsx",

            content: "Updated content",

          },

        ],

      });

      await expect(inspectPortfolioNode(createState({ stage: "inspecting" }))).rejects.toThrow(

        "LLM proposed an update for an unread file",

      );

    });

    it("rejects additional file requests after the inspection limit", async () => {

      mocks.llmInvoke.mockResolvedValue({

        summary: "More context is needed.",

        needsMoreFiles: true,

        filesToRead: ["src/app/projects/page.tsx"],

        updates: [],

      });

      const result = await inspectPortfolioNode(

        createState({

          stage: "inspecting",

          inspectionRounds: 4,

        }),

      );

      expect(result.stage).toBe("failed");

      expect(result.errors?.[0]).toContain("Inspection limit reached");

    });

    it("rejects additional inspection requests without file paths", async () => {

      mocks.llmInvoke.mockResolvedValue({

        summary: "More context is needed.",

        needsMoreFiles: true,

        filesToRead: [],

        updates: [],

      });

      const result = await inspectPortfolioNode(createState({ stage: "inspecting" }));

      expect(result.stage).toBe("failed");

      expect(result.errors?.[0]).toContain("did not provide any file paths");

    });

    it("rejects requests for unavailable files", async () => {

      mocks.llmInvoke.mockResolvedValue({

        summary: "More context is needed.",

        needsMoreFiles: true,

        filesToRead: ["private.txt"],

        updates: [],

      });

      const result = await inspectPortfolioNode(createState({ stage: "inspecting" }));

      expect(result.stage).toBe("failed");

      expect(result.errors?.[0]).toContain("not in the portfolio");

    });

  });

  describe("updatePortfolioFilesNode", () => {

    it("updates files and proceeds to validation", async () => {

      mocks.updateFilesInvoke.mockResolvedValue(

        JSON.stringify({

          success: true,

          totalRequested: 1,

          totalUpdated: 1,

          files: [{ path: "src/app/page.tsx", success: true }],

        }),

      );

      const result = await updatePortfolioFilesNode(

        createState({

          stage: "updating",

          filesToUpdate: [

            {

              path: "src/app/page.tsx",

              content: "Updated homepage",

            },

          ],

        }),

      );

      expect(result.stage).toBe("validating");

      expect(result.updatedPaths).toEqual(["src/app/page.tsx"]);

    });

    it("rejects updates when the stage is incorrect", async () => {

      await expect(updatePortfolioFilesNode(createState({ stage: "inspecting" }))).rejects.toThrow(

        "Portfolio updates are not allowed",

      );

    });

    it("fails when a file update fails", async () => {

      mocks.updateFilesInvoke.mockResolvedValue(

        JSON.stringify({

          success: false,

          totalRequested: 1,

          totalUpdated: 0,

          files: [

            {

              path: "src/app/page.tsx",

              success: false,

              error: "Write failed",

            },

          ],

        }),

      );

      await expect(

        updatePortfolioFilesNode(

          createState({

            stage: "updating",

            filesToUpdate: [

              {

                path: "src/app/page.tsx",

                content: "Updated homepage",

              },

            ],

          }),

        ),

      ).rejects.toThrow("Write failed");

    });

  });

  describe("validatePortfolioNode", () => {

    it("proceeds to publishing when validation succeeds", async () => {

      mocks.validatePortfolio.mockResolvedValue({

        success: true,

        checks: { gitDiff: true, build: true },

        buildStatus: "passed",

        messages: ["Build passed"],

      });

      const result = await validatePortfolioNode(createState({ stage: "validating" }));

      expect(result.stage).toBe("publishing");

    });

    it("stops when validation fails", async () => {

      mocks.validatePortfolio.mockResolvedValue({

        success: false,

        checks: { gitDiff: true, build: false },

        buildStatus: "failed",

        messages: ["Build failed"],

      });

      const result = await validatePortfolioNode(createState({ stage: "validating" }));

      expect(result.stage).toBe("failed");

      expect(result.errors).toContain("Build failed");

    });

  });

  describe("publishPortfolioNode", () => {

    it("completes when a pull request is created", async () => {

      mocks.publishPortfolioChanges.mockResolvedValue({

        success: true,

        branch: "career-sync/update-123",

        commit: "abc123",

        pullRequestUrl: "https\://github.com/example/portfolio/pull/1",

        message: "PR created",

      });

      const result = await publishPortfolioNode(

        createState({

          stage: "publishing",

          updatedPaths: ["src/app/page.tsx"],

        }),

      );

      expect(result.stage).toBe("completed");

      expect(result.pullRequestUrl).toBe("https\://github.com/example/portfolio/pull/1");

    });

    it("rejects publishing when no files were updated", async () => {

      await expect(

        publishPortfolioNode(

          createState({

            stage: "publishing",

            updatedPaths: [],

          }),

        ),

      ).rejects.toThrow("No successfully updated files");

      expect(mocks.publishPortfolioChanges).not.toHaveBeenCalled();

    });

    it("propagates publishing failures", async () => {

      mocks.publishPortfolioChanges.mockRejectedValue(new Error("GitHub API unavailable"));

      await expect(

        publishPortfolioNode(

          createState({

            stage: "publishing",

            updatedPaths: ["src/app/page.tsx"],

          }),

        ),

      ).rejects.toThrow("GitHub API unavailable");

    });

  });

});
