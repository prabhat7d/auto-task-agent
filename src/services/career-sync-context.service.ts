import { getPreviousResume } from "./previous-resume.service.js";
import type { ParsedResume } from "./resume.service.js";
import { getPortfolioFiles } from "../tools/get-portfolio-files.tool.js";

const PORTFOLIO_STRUCTURE = `
Portfolio architecture:

1. Homepage:
   The homepage contains brief sections representing the different areas
   of the portfolio, giving visitors an overview of everything.

2. Separate pages:
   Each major section also has its own dedicated page containing more
   detailed information.

3. Updating the portfolio:
   When updating the portfolio based on the new resume, consider both
   the homepage's brief sections and the corresponding detailed pages.

   First, inspect the existing implementation before deciding which files
   need to be updated. Preserve the existing design, structure, and
   functionality wherever possible.
`;

export interface CareerSyncContext {
  previousResume: string;
  newResume: string;
  portfolioFiles: string[];
  portfolioStructure: string;
}

export async function createCareerSyncContext(newResume: ParsedResume): Promise<CareerSyncContext> {
  // Read the existing resume from the portfolio repository.
  const previousResume = await getPreviousResume();

  // Retrieve the portfolio's tracked file paths.
  const portfolioFilesResult = await getPortfolioFiles.invoke({});

  const portfolioFilesResponse = JSON.parse(portfolioFilesResult as string) as {
    success: boolean;
    totalFiles: number;
    files: string[];
  };

  if (!portfolioFilesResponse.success) {
    throw new Error("Failed to retrieve portfolio file paths.");
  }

  // console.log("Previous resume contains AWSS:", previousResume);
  // console.log("New resume contains AWSS:", newResume);

  return {
    previousResume: previousResume.text,
    newResume: newResume.text,
    portfolioFiles: portfolioFilesResponse.files,
    portfolioStructure: PORTFOLIO_STRUCTURE,
  };
}
