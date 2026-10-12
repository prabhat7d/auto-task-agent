import { END, START, StateGraph } from "@langchain/langgraph";

import { CareerSyncState } from "./career-sync.state.js";

import {
  initialAnalysisNode,
  readPortfolioFilesNode,
  inspectPortfolioNode,
  updatePortfolioFilesNode,
  validatePortfolioNode,
  publishPortfolioNode,
} from "./career-sync.nodes.js";

function routeAfterReading(state: typeof CareerSyncState.State) {
  if (state.stage === "failed") {
    return END;
  }

  return "inspect_portfolio";
}

function routeAfterInspection(state: typeof CareerSyncState.State) {
  if (state.stage === "failed" || state.stage === "completed") {
    return END;
  }

  if (state.stage === "reading") {
    return "read_portfolio_files";
  }

  if (state.stage === "updating") {
    return "update_portfolio_files";
  }

  return END;
}

function routeAfterValidation(state: typeof CareerSyncState.State) {
  if (state.stage === "failed") {
    return END;
  }

  return "publish_portfolio";
}

function routeAfterInitialAnalysis(state: typeof CareerSyncState.State) {
  if (state.stage === "failed" || state.stage === "completed") {
    return END;
  }

  return "read_portfolio_files";
}

export const careerSyncGraph = new StateGraph(CareerSyncState)
  .addNode("initial_analysis", initialAnalysisNode)
  .addNode("read_portfolio_files", readPortfolioFilesNode)
  .addNode("inspect_portfolio", inspectPortfolioNode)
  .addNode("update_portfolio_files", updatePortfolioFilesNode)
  .addNode("validate_portfolio", validatePortfolioNode)
  .addNode("publish_portfolio", publishPortfolioNode)

  .addEdge(START, "initial_analysis")
  .addConditionalEdges("initial_analysis", routeAfterInitialAnalysis)

  .addConditionalEdges("read_portfolio_files", routeAfterReading)
  .addConditionalEdges("inspect_portfolio", routeAfterInspection)

  .addEdge("update_portfolio_files", "validate_portfolio")
  .addConditionalEdges("validate_portfolio", routeAfterValidation)

  .addEdge("publish_portfolio", END)

  .compile();
