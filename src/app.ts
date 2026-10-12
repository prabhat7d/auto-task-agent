import express from "express";
import cors from "cors";
import careerSyncRouter from "./routes/career-sync.routes.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Auto Task Agent API is running.",
  });
});

app.use("/api/agents/career-sync", careerSyncRouter);

export default app;
