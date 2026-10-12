import { Annotation } from "@langchain/langgraph";
import type { CareerSyncContext } from "../services/career-sync-context.service.js";
import type { InitialAnalysis } from "../agents/career-sync/initial-analysis.service.js";

export type CareerSyncStage =
  | "initial_analysis"
  | "reading"
  | "inspecting"
  | "updating"
  | "validating"
  | "publishing"
  | "completed"
  | "failed";

export interface ReadFileResult {
  path: string;
  success: boolean;
  content?: string;
  error?: string;
}

export interface FileUpdate {
  path: string;
  content: string;
}

export const CareerSyncState = Annotation.Root({
  context: Annotation<CareerSyncContext | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  initialAnalysis: Annotation<InitialAnalysis | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  stage: Annotation<CareerSyncStage>({
    reducer: (_, next) => next,
    default: () => "initial_analysis",
  }),

  filesToRead: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  readResults: Annotation<ReadFileResult[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  inspectionRounds: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),

  filesToUpdate: Annotation<FileUpdate[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  updatedPaths: Annotation<string[]>({
    reducer: (current, next) => [...current, ...next],
    default: () => [],
  }),

  errors: Annotation<string[]>({
    reducer: (current, next) => [...current, ...next],
    default: () => [],
  }),

  pullRequestUrl: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  resumeBuffer: Annotation<Buffer | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

export type CareerSyncStateType = typeof CareerSyncState.State;
