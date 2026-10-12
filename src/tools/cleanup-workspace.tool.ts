import fs from "node:fs/promises";
import path from "node:path";

export async function cleanupWorkspace(): Promise<{
  success: boolean;
  message: string;
}> {
  const workspacePath = path.resolve(process.cwd(), "workspaces", "portfolio");

  await fs.rm(workspacePath, {
    recursive: true,
    force: true,
  });

  console.log("[CareerSync] Portfolio workspace cleaned.");

  return {
    success: true,
    message: "Portfolio workspace deleted successfully.",
  };
}
