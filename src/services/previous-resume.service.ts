import fs from "node:fs/promises";
import path from "node:path";
import { ensurePortfolioRepository } from "./portfolio-repository.service.js";
import { parseResume } from "./resume.service.js";

const PREVIOUS_RESUME_PATH = path.join("public", "Prabhat.pdf");

export async function getPreviousResume() {
  const repositoryPath = await ensurePortfolioRepository();

  const resumePath = path.join(repositoryPath, PREVIOUS_RESUME_PATH);

  let resumeBuffer: Buffer;

  try {
    resumeBuffer = await fs.readFile(resumePath);
  } catch {
    throw new Error(
      `Previous resume not found at ${PREVIOUS_RESUME_PATH} in the portfolio repository.`,
    );
  }

  return parseResume("Prabhat.pdf", resumeBuffer);
}
