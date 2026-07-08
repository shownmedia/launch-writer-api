import express from "express";
import cors from "cors";
import { runPipeline, getSession, getAllSessions } from "./orchestrator";
import { chatWithUser } from "./claude";
import { initDb } from "./db";
import type { BrandInfo } from "./types";
import type { Response } from "express";

const app = express();
const PORT = parseInt(process.env.PORT || "3001");

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "launch-writer-api" });
});

// ──────────────────────────────────────────────
// CHAT: Conversational brand info collection
// ──────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

  const stream = await chatWithUser(messages);
  const reader = stream.getReader();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (err) {
    console.error("[Chat] Stream error:", err);
  } finally {
    res.end();
  }
});

// ──────────────────────────────────────────────
// PIPELINE: Start the full 17-step pipeline
// ──────────────────────────────────────────────

// Active SSE connections per session
const sseClients = new Map<string, Set<Response>>();

app.post("/api/pipeline/launch", async (req, res) => {
  const { brandInfo, driveFolderId } = req.body as {
    brandInfo: BrandInfo;
    driveFolderId?: string;
  };

  if (!brandInfo?.brandName) {
    res.status(400).json({ error: "brandInfo with brandName required" });
    return;
  }

  // Create a session ID upfront
  const sessionId = `launch-${Date.now().toString(36)}`;
  sseClients.set(sessionId, new Set());

  // Return session info immediately
  res.json({
    sessionId,
    streamUrl: `/api/pipeline/stream/${sessionId}`,
    brandName: brandInfo.brandName,
  });

  // Run pipeline in background
  runPipeline(brandInfo, driveFolderId, (event) => {
    const clients = sseClients.get(sessionId);
    if (clients) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) {
        try {
          client.write(data);
        } catch {
          clients.delete(client);
        }
      }
      if (event.type === "done" || event.type === "error") {
        for (const client of clients) {
          try {
            client.end();
          } catch {
            // ignore
          }
        }
        setTimeout(() => sseClients.delete(sessionId), 60000);
      }
    }
  }, sessionId).catch((err) => {
    console.error("[Pipeline] Fatal error:", err);
  });
});

// SSE stream for pipeline progress
app.get("/api/pipeline/stream/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Send initial heartbeat
  res.write(`data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`);

  // Register this client
  if (!sseClients.has(sessionId)) {
    sseClients.set(sessionId, new Set());
  }
  sseClients.get(sessionId)!.add(res);

  // Cleanup on disconnect
  req.on("close", () => {
    const clients = sseClients.get(sessionId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(sessionId);
    }
  });
});

// Get session status/outputs
app.get("/api/pipeline/session/:sessionId", async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) {
    // Try to find by partial match
    const all = await getAllSessions();
    const match = all.find((s) => s.id.includes(req.params.sessionId));
    if (match) {
      res.json(match);
      return;
    }
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

// List all sessions
app.get("/api/pipeline/sessions", async (_req, res) => {
  const all = (await getAllSessions()).map((s) => ({
    id: s.id,
    brandName: s.brandName,
    status: s.status,
    createdAt: s.createdAt,
    googleDocUrl: s.googleDocUrl,
    steps: s.steps.map((st) => ({
      name: st.name,
      status: st.status,
    })),
  }));
  res.json(all);
});

// Get specific output from a session
app.get("/api/pipeline/session/:sessionId/output/:outputKey", async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const output = session.outputs[req.params.outputKey];
  if (!output) {
    res.status(404).json({ error: "Output not found", available: Object.keys(session.outputs) });
    return;
  }
  res.json({ key: req.params.outputKey, content: output });
});

app.listen(PORT, async () => {
  console.log(`🚀 Launch Writer API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Chat:   POST http://localhost:${PORT}/api/chat`);
  console.log(`   Launch: POST http://localhost:${PORT}/api/pipeline/launch`);
  console.log(`\n   Environment:`);
  console.log(`   - ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗"}`);
  console.log(`   - OPENAI_API_KEY:    ${process.env.OPENAI_API_KEY ? "✓" : "✗"}`);
  console.log(`   - YOUTUBE_API_KEY:   ${process.env.YOUTUBE_API_KEY ? "✓" : "✗"}`);
  console.log(`   - APIFY_TOKEN:       ${process.env.APIFY_TOKEN ? "✓" : "✗"}`);
  console.log(`   - APIFY_TOKEN_REDDIT: ${process.env.APIFY_TOKEN_REDDIT ? "✓" : "✗"}`);
  console.log(`   - GOOGLE_SERVICE_ACCOUNT_JSON: ${process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? "✓" : "✗"}`);
  console.log(`   - DATABASE_URL:      ${process.env.DATABASE_URL ? "✓" : "✗ (in-memory only)"}`);

  try {
    await initDb();
  } catch (err) {
    console.error("[db] init failed — falling back to in-memory sessions:", err);
  }
});
