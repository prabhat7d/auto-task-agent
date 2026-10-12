import { ChatOpenAI } from "@langchain/openai";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is not configured.");
}

export const llm = new ChatOpenAI({
  model: "gpt-4.1-mini",
  temperature: 0,
  apiKey,
});
