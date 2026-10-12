import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseResume: vi.fn(),
  createCareerSyncContext: vi.fn(),
  graphInvoke: vi.fn(),
}));

vi.mock("../src/services/resume.service.js", () => ({
  parseResume: mocks.parseResume,
}));

vi.mock("../src/services/career-sync-context.service.js", () => ({
  createCareerSyncContext: mocks.createCareerSyncContext,
}));

vi.mock("../src/graph/career-sync.graph.js", () => ({
  careerSyncGraph: {
    invoke: mocks.graphInvoke,
  },
}));

import careerSyncRouter from "../src/routes/career-sync.routes.js";

function createApp() {
  const app = express();
  app.use("/", careerSyncRouter);
  return app;
}

function attachResume(app: express.Express, filename = "resume.pdf") {
  return request(app).post("/run").attach("resume", Buffer.from("%PDF-1.7 mock resume"), {
    filename,
    contentType: "application/pdf",
  });
}

describe("CareerSync API", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.parseResume.mockResolvedValue({
      fileName: "resume.pdf",
      text: "Updated resume text",
      characterCount: 20,
    });

    mocks.createCareerSyncContext.mockResolvedValue({
      previousResume: "Previous resume",
      newResume: "Updated resume",
      portfolioFiles: ["src/app/page.tsx"],
      portfolioStructure: "Homepage and detailed pages",
    });

    mocks.graphInvoke.mockResolvedValue({
      stage: "completed",
      updatedPaths: [],
      pullRequestUrl: null,
      errors: [],
    });
  });

  it("rejects a request without a resume", async () => {
    const app = createApp();

    const response = await request(app).post("/run");

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toContain("Resume PDF is required");
  });

  it("rejects a file that does not have a PDF extension", async () => {
    const app = createApp();

    const response = await attachResume(app, "resume.txt");

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toContain("PDF");
    expect(mocks.graphInvoke).not.toHaveBeenCalled();
  });

  it("rejects a file with an incorrect MIME type", async () => {
    const app = createApp();

    const response = await request(app).post("/run").attach("resume", Buffer.from("not a PDF"), {
      filename: "resume.pdf",
      contentType: "text/plain",
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(mocks.graphInvoke).not.toHaveBeenCalled();
  });

  it("rejects a resume larger than 5 MB", async () => {
    const app = createApp();
    const oversizedResume = Buffer.alloc(5 * 1024 * 1024 + 1, 65);

    const response = await request(app).post("/run").attach("resume", oversizedResume, {
      filename: "resume.pdf",
      contentType: "application/pdf",
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toContain("5 MB");
    expect(mocks.graphInvoke).not.toHaveBeenCalled();
  });

  it("parses the resume and executes the workflow", async () => {
    const app = createApp();

    const response = await attachResume(app);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.stage).toBe("completed");

    expect(mocks.parseResume).toHaveBeenCalledOnce();
    expect(mocks.createCareerSyncContext).toHaveBeenCalledOnce();
    expect(mocks.graphInvoke).toHaveBeenCalledOnce();
  });

  it("returns a successful response when no changes are needed", async () => {
    const app = createApp();

    mocks.graphInvoke.mockResolvedValue({
      stage: "completed",
      updatedPaths: [],
      pullRequestUrl: null,
      errors: [],
    });

    const response = await attachResume(app);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toContain("No portfolio changes were required");
    expect(response.body.pullRequestUrl).toBeNull();
  });

  it("returns 422 when the workflow reports failure", async () => {
    const app = createApp();

    mocks.graphInvoke.mockResolvedValue({
      stage: "failed",
      updatedPaths: [],
      pullRequestUrl: null,
      errors: ["Portfolio validation failed"],
    });

    const response = await attachResume(app);

    expect(response.status).toBe(422);
    expect(response.body.success).toBe(false);
    expect(response.body.errors).toContain("Portfolio validation failed");
  });

  it("returns 500 when workflow execution throws", async () => {
    const app = createApp();

    mocks.graphInvoke.mockRejectedValue(new Error("Unexpected workflow error"));

    const response = await attachResume(app);

    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toContain("Unexpected workflow error");
  });

  it("rejects a concurrent request with HTTP 409", async () => {
    const app = createApp();

    let releaseGraph!: () => void;
    let signalGraphStarted!: () => void;

    const graphStarted = new Promise<void>((resolve) => {
      signalGraphStarted = resolve;
    });

    const graphBlocked = new Promise<void>((resolve) => {
      releaseGraph = resolve;
    });

    mocks.graphInvoke.mockImplementation(async () => {
      signalGraphStarted();

      await graphBlocked;

      return {
        stage: "completed",
        updatedPaths: [],
        pullRequestUrl: null,
        errors: [],
      };
    });

    const firstRequest = attachResume(app).then((response) => response);

    try {
      // Wait until the first request actually enters the workflow.
      await graphStarted;

      // The first workflow is still blocked, so this request must be rejected.
      const secondResponse = await attachResume(app);

      expect(secondResponse.status).toBe(409);
      expect(secondResponse.body.success).toBe(false);
      expect(secondResponse.body.message).toContain("already running");
    } finally {
      // Always release the first workflow to avoid leaving a pending request.
      releaseGraph();
    }

    const firstResponse = await firstRequest;

    expect(firstResponse.status).toBe(200);
    expect(mocks.graphInvoke).toHaveBeenCalledOnce();
  });

  it("releases the concurrency lock after a workflow error", async () => {
    const app = createApp();

    mocks.graphInvoke.mockRejectedValueOnce(new Error("First run failed")).mockResolvedValueOnce({
      stage: "completed",
      updatedPaths: [],
      pullRequestUrl: null,
      errors: [],
    });

    const firstResponse = await attachResume(app);

    expect(firstResponse.status).toBe(500);

    const secondResponse = await attachResume(app);

    expect(secondResponse.status).toBe(200);
  });
});
