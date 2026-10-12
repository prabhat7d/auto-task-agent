import { Router } from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";

import { parseResume } from "../services/resume.service.js";
import { createCareerSyncContext } from "../services/career-sync-context.service.js";
import { validatePortfolio } from "../services/portfolio-validation.service.js";
import { publishPortfolioChanges } from "../services/github-publishing.service.js";
import { careerSyncGraph } from "../graph/career-sync.graph.js";
import { cleanupWorkspace } from "../tools/cleanup-workspace.tool.js";

const router = Router();

let careerSyncRunning = false;

const PORTFOLIO_PATH = path.resolve(process.cwd(), "workspaces", "portfolio");
const RESUME_PATH = path.join(PORTFOLIO_PATH, "public", "Prabhat.pdf");
const RESUME_RELATIVE_PATH = "public/Prabhat.pdf";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== "application/pdf" || !file.originalname.toLowerCase().endsWith(".pdf")) {
      callback(new Error("Please upload a PDF resume."));
      return;
    }

    callback(null, true);
  },
});

router.post("/run", (req, res, next) => {
  upload.single("resume")(req, res, (error) => {
    if (error) {
      const message =
        error instanceof multer.MulterError
          ? error.code === "LIMIT_FILE_SIZE"
            ? "Resume PDF must not exceed 5 MB."
            : "Invalid upload. Please upload a single PDF resume."
          : error.message || "Failed to upload resume.";

      res.status(400).json({
        success: false,
        message,
      });

      return;
    }

    next();
  });
});

router.post("/run", async (req, res) => {
  // Reject concurrent runs before starting any workflow processing.
  if (careerSyncRunning) {
    res.status(409).json({
      success: false,
      message: "CareerSync is already running. Please try again later.",
    });

    return;
  }

  careerSyncRunning = true;

  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        message: "Resume PDF is required.",
      });

      return;
    }

    // 1. Extract text from the uploaded resume.
    const newResume = await parseResume(req.file.originalname, req.file.buffer);

    // 2. Copy the exact uploaded PDF bytes to the portfolio before the workflow
    //    can validate or publish any changes.
    let resumeFileChanged = true;

    try {
      const existingResume = await fs.readFile(RESUME_PATH);
      resumeFileChanged = !existingResume.equals(req.file.buffer);
    } catch {
      // The resume does not exist yet, or cannot be read. The write below will
      // either create/replace it or surface the filesystem error.
      resumeFileChanged = true;
    }

    // 3. Prepare the previous resume, new resume and portfolio context.
    const context = await createCareerSyncContext(newResume);

    // 4. Execute the CareerSync workflow.
    const result = await careerSyncGraph.invoke({
      context,
      resumeBuffer: req.file.buffer,
    });

    if (result.stage === "failed") {
      res.status(422).json({
        success: false,
        message: "CareerSync workflow failed.",
        errors: result.errors,
      });

      return;
    }

    let pullRequestUrl = result.pullRequestUrl;

    // If the portfolio content needed no edits, the graph completes without
    // entering its publishing stage. Still validate and publish the resume PDF.
    // if (
    //   result.stage === "completed" &&
    //   !pullRequestUrl &&
    //   resumeFileChanged &&
    //   (result.updatedPaths ?? []).length === 0
    // ) {
    //   const validation = await validatePortfolio();

    //   if (!validation.success) {
    //     res.status(422).json({
    //       success: false,
    //       message: "Portfolio validation failed before publishing the updated resume.",
    //       errors: validation.messages,
    //     });

    //     return;
    //   }

    //   const publishResult = await publishPortfolioChanges([RESUME_RELATIVE_PATH]);
    //   pullRequestUrl = publishResult.pullRequestUrl;
    // }

    res.status(200).json({
      success: true,
      message:
        result.stage === "completed" && !pullRequestUrl
          ? "CareerSync completed. No portfolio changes were required."
          : "CareerSync workflow completed.",
      stage: result.stage,
      updatedFiles: [...new Set(result.updatedPaths ?? [])],
      pullRequestUrl,
    });
  } catch (error) {
    console.error("CareerSync error:", error);

    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "An unexpected error occurred.",
    });
  } finally {
    // Always release the lock, including on early returns and exceptions.
    try {
      await cleanupWorkspace();
    } catch (cleanupError) {
      console.error("Failed to clean up portfolio workspace:", cleanupError);
    } finally {
      // Always release the lock, including on early returns and exceptions.
      careerSyncRunning = false;
    }
  }
});

export default router;
