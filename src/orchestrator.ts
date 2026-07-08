/**
 * Pipeline Orchestrator — manages the 17-step Alejandro Bot pipeline.
 * Each step spawns a sub-agent via the Anthropic API with the correct
 * prompt files, exactly replicating `claude -p "..."` from Claude Code.
 */

import { v4 as uuid } from "uuid";
import { callAgent } from "./claude";
import { runYouTubeResearch } from "./tools/youtube";
import { runXResearch } from "./tools/apify-x";
import { runRedditResearch } from "./tools/apify-reddit";
import { createDoc, appendToDoc, writeFinalScript } from "./tools/google-docs";
import { LaunchSession, BrandInfo, StepStatus } from "./types";
import { saveSession, loadSession, loadAllSessions } from "./db";

// In-memory cache of the currently-running session(s); the durable source of
// truth is Postgres (see db.ts) so runs survive Railway restarts.
const sessions = new Map<string, LaunchSession>();

export async function getSession(id: string): Promise<LaunchSession | undefined> {
  const fromDb = await loadSession(id);
  if (fromDb) return fromDb;
  return sessions.get(id);
}

export async function getAllSessions(): Promise<LaunchSession[]> {
  const fromDb = await loadAllSessions();
  if (fromDb.length) return fromDb;
  return Array.from(sessions.values());
}

type ProgressCallback = (event: {
  type: string;
  step?: string;
  status?: StepStatus;
  message?: string;
  data?: unknown;
}) => void;

function buildBrief(info: BrandInfo): string {
  const lines = [
    `# Brand Brief: ${info.brandName}`,
    "",
    `## Product`,
    info.productDescription || "Not provided",
    "",
    `## Category`,
    info.category || "Not provided",
    "",
    `## Target Audience`,
    info.targetAudience || "Not provided",
    "",
    `## Key Features`,
    info.keyFeatures?.map((f) => `- ${f}`).join("\n") || "Not provided",
    "",
    `## Funding & Credibility`,
    info.funding || "Not provided",
    info.investors ? `Investors: ${info.investors}` : "",
    "",
    `## Social Proof`,
    info.socialProof || "Not provided",
    "",
    `## Enemy (What This Kills/Replaces)`,
    info.enemy || "Not provided",
    "",
    `## Giveaway Asset`,
    info.giveawayAsset || "Not provided",
  ];

  if (info.fathomTranscript) {
    lines.push("", "## Fathom Call Transcript", info.fathomTranscript);
  }
  if (info.additionalContext) {
    lines.push("", "## Additional Context", info.additionalContext);
  }

  return lines.join("\n");
}

/**
 * Run the full 17-step pipeline.
 */
export async function runPipeline(
  brandInfo: BrandInfo,
  driveFolderId?: string,
  onProgress?: ProgressCallback,
  sessionId?: string
): Promise<LaunchSession> {
  const session: LaunchSession = {
    // Use the caller-supplied id (the one returned to the client) so the
    // frontend can poll /api/pipeline/session/:id with the same id. Falls back
    // to a uuid if none is provided.
    id: sessionId || uuid(),
    brandName: brandInfo.brandName,
    status: "running",
    createdAt: new Date(),
    updatedAt: new Date(),
    driveFolderId,
    steps: [],
    currentStep: 0,
    outputs: {},
    brandInfo,
  };

  sessions.set(session.id, session);

  // Fire-and-forget persistence: a DB hiccup must never break a run. Full-state
  // upserts are last-write-wins, and the terminal state is awaited below.
  const persist = () => {
    void saveSession(session).catch((e) =>
      console.error("[db] persist failed:", e instanceof Error ? e.message : e)
    );
  };
  persist();

  const emit = (type: string, step?: string, status?: StepStatus, message?: string) => {
    session.updatedAt = new Date();
    if (onProgress) onProgress({ type, step, status, message });
  };

  const updateStep = (name: string, status: StepStatus, error?: string) => {
    const step = session.steps.find((s) => s.name === name);
    if (step) {
      step.status = status;
      if (status === "running") step.startedAt = new Date();
      if (status === "completed" || status === "failed") step.completedAt = new Date();
      if (error) step.error = error;
    }
    persist();
    emit("step_update", name, status, error);
  };

  const addStep = (name: string, agent: string, model: "opus" | "sonnet") => {
    session.steps.push({
      id: uuid(),
      name,
      agent,
      model,
      status: "pending",
    });
  };

  // Define all steps
  addStep("Brand Brief", "setup", "sonnet");
  addStep("Keywords", "research-agent", "sonnet");
  addStep("YouTube Research", "youtube-research", "sonnet");
  addStep("X/Twitter Research", "x-research", "sonnet");
  addStep("Reddit Research", "reddit-research", "sonnet");
  addStep("Industry Research", "industry-research", "sonnet");
  addStep("Research Compiler", "research-compiler", "sonnet");
  addStep("Hook Writer", "hook-writer", "opus");
  addStep("Hook Manager", "hook-manager", "opus");
  addStep("Giveaway Writer", "giveaway-writer", "opus");
  addStep("Giveaway Manager", "giveaway-manager", "opus");
  addStep("Body Writer", "body-writer", "opus");
  addStep("Weapons Specialist", "weapons-specialist", "opus");
  addStep("Controversy Specialist", "controversy-specialist", "opus");
  addStep("Technical Specialist", "technical-specialist", "opus");
  addStep("Flow Specialist", "flow-specialist", "opus");
  addStep("Body Manager", "body-manager", "opus");
  addStep("Mom Test", "mom-test", "sonnet");
  addStep("Call Supervisor", "call-supervisor", "sonnet");
  addStep("Final Review", "final-review", "opus");
  addStep("Deliver", "setup", "sonnet");

  try {
    const brief = buildBrief(brandInfo);
    session.outputs["brief"] = brief;

    // ── STEP 1: Google Doc Setup ──
    updateStep("Brand Brief", "running");
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      try {
        const { docId, docUrl } = await createDoc(
          `${brandInfo.brandName}: LAUNCH SCRIPT`,
          driveFolderId
        );
        session.googleDocId = docId;
        session.googleDocUrl = docUrl;
        await appendToDoc(docId, `BRAND BRIEF\n\n${brief}`);
      } catch (err) {
        console.error("[Pipeline] Google Docs setup failed, continuing without:", err);
      }
    }
    updateStep("Brand Brief", "completed");

    // ── STEP 2: Keywords ──
    updateStep("Keywords", "running");
    const keywords = await callAgent("research-agent", { brief });
    session.outputs["keywords"] = keywords;

    // Extract the top 15 keywords as a list for tool use
    const keywordLines = keywords
      .split("\n")
      .filter((l) => l.match(/^\d+\.\s/) || l.match(/^-\s/))
      .slice(0, 15)
      .map((l) => l.replace(/^\d+\.\s*|-\s*/, "").trim());
    session.outputs["keywords_top15"] = keywordLines.join("\n");
    updateStep("Keywords", "completed");

    // ── PHASE 2: Research (4 agents PARALLEL) ──
    emit("progress", undefined, undefined, "Starting parallel research (YouTube, X, Reddit, Industry)...");

    const researchPromises = [
      // YouTube: Use tool directly + Claude agent for analysis
      (async () => {
        updateStep("YouTube Research", "running");
        try {
          const rawYT = await runYouTubeResearch(keywordLines.slice(0, 15));
          // Pass raw results to Claude for ceiling/floor analysis + nugget extraction
          const analyzed = await callAgent("youtube-research", {
            keywords_top15: session.outputs["keywords_top15"],
            brief,
            raw_youtube_data: rawYT,
          });
          session.outputs["youtube_research"] = analyzed;
          updateStep("YouTube Research", "completed");
        } catch (err) {
          console.error("[Pipeline] YouTube research failed:", err);
          session.outputs["youtube_research"] = "YouTube research failed. Continuing with other sources.";
          updateStep("YouTube Research", "failed", String(err));
        }
      })(),

      // X/Twitter: Use Apify tool + Claude agent for analysis
      (async () => {
        updateStep("X/Twitter Research", "running");
        try {
          const brandKw = brandInfo.brandName + " " + (brandInfo.category || "");
          const competitor = brandInfo.enemy || brandInfo.category || "";
          const industry = brandInfo.category || "";
          const icp = brandInfo.targetAudience || "";
          const rawX = await runXResearch(brandKw, competitor, industry, icp);
          const analyzed = await callAgent("x-research", {
            keywords_top15: session.outputs["keywords_top15"],
            brief,
            raw_x_data: rawX,
          });
          session.outputs["x_research"] = analyzed;
          updateStep("X/Twitter Research", "completed");
        } catch (err) {
          console.error("[Pipeline] X research failed:", err);
          session.outputs["x_research"] = "X research failed. Continuing with other sources.";
          updateStep("X/Twitter Research", "failed", String(err));
        }
      })(),

      // Reddit: Use Apify tool + Claude agent for analysis
      (async () => {
        updateStep("Reddit Research", "running");
        try {
          const rawReddit = await runRedditResearch(
            brandInfo.category || brandInfo.brandName,
            brandInfo.enemy || "",
            brandInfo.targetAudience || ""
          );
          const analyzed = await callAgent("reddit-research", {
            brief,
            raw_reddit_data: rawReddit,
          });
          session.outputs["reddit_pain"] = analyzed;
          updateStep("Reddit Research", "completed");
        } catch (err) {
          console.error("[Pipeline] Reddit research failed:", err);
          session.outputs["reddit_pain"] = "Reddit research failed. Continuing with other sources.";
          updateStep("Reddit Research", "failed", String(err));
        }
      })(),

      // Industry: Claude agent with web search context
      (async () => {
        updateStep("Industry Research", "running");
        try {
          const result = await callAgent("industry-research", { brief });
          session.outputs["industry_data"] = result;
          updateStep("Industry Research", "completed");
        } catch (err) {
          console.error("[Pipeline] Industry research failed:", err);
          session.outputs["industry_data"] = "Industry research failed.";
          updateStep("Industry Research", "failed", String(err));
        }
      })(),
    ];

    await Promise.all(researchPromises);

    // ── STEP 4: Research Compiler ──
    updateStep("Research Compiler", "running");
    const researchBrief = await callAgent("research-compiler", {
      brief,
      youtube_research: session.outputs["youtube_research"] || "",
      x_research: session.outputs["x_research"] || "",
      reddit_pain: session.outputs["reddit_pain"] || "",
      industry_data: session.outputs["industry_data"] || "",
    });
    session.outputs["research_brief"] = researchBrief;
    updateStep("Research Compiler", "completed");

    // Write research to Google Doc
    if (session.googleDocId) {
      try {
        await appendToDoc(session.googleDocId, `\n\n${"=".repeat(50)}\nRESEARCH BRIEF\n${"=".repeat(50)}\n\n${researchBrief}`);
      } catch (err) {
        console.error("[Pipeline] Google Docs write failed:", err);
      }
    }

    // ── PHASE 3: Hooks + Giveaway (PARALLEL) ──
    emit("progress", undefined, undefined, "Writing hooks and giveaway in parallel...");

    const [hooksDraft, giveawayDraft] = await Promise.all([
      // Track A: Hook Writer
      (async () => {
        updateStep("Hook Writer", "running");
        const result = await callAgent("hook-writer", {
          brief,
          research_brief: researchBrief,
        });
        session.outputs["hooks_draft"] = result;
        updateStep("Hook Writer", "completed");
        return result;
      })(),

      // Track B: Giveaway Writer
      (async () => {
        updateStep("Giveaway Writer", "running");
        const result = await callAgent("giveaway-writer", {
          brief,
          research_brief: researchBrief,
        });
        session.outputs["giveaway_draft"] = result;
        updateStep("Giveaway Writer", "completed");
        return result;
      })(),
    ]);

    // Managers (parallel)
    const [hooksApproved, giveawayApproved] = await Promise.all([
      (async () => {
        updateStep("Hook Manager", "running");
        const result = await callAgent("hook-manager", {
          hooks_draft: hooksDraft,
          brief,
        });
        session.outputs["hooks_approved"] = result;
        updateStep("Hook Manager", "completed");
        return result;
      })(),

      (async () => {
        updateStep("Giveaway Manager", "running");
        const result = await callAgent("giveaway-manager", {
          giveaway_draft: giveawayDraft,
          brief,
        });
        session.outputs["giveaway_approved"] = result;
        updateStep("Giveaway Manager", "completed");
        return result;
      })(),
    ]);

    // ── PHASE 4: Body (sequential chain) ──
    emit("progress", undefined, undefined, "Writing body...");

    updateStep("Body Writer", "running");
    const bodyDraft = await callAgent("body-writer", {
      brief,
      research_brief: researchBrief,
      hooks_approved: hooksApproved,
    });
    session.outputs["body_draft"] = bodyDraft;
    updateStep("Body Writer", "completed");

    // Specialists chain (sequential — each builds on the last)
    updateStep("Weapons Specialist", "running");
    const weaponsDone = await callAgent("weapons-specialist", {
      body_draft: bodyDraft,
      brief,
    });
    session.outputs["weapons_done"] = weaponsDone;
    updateStep("Weapons Specialist", "completed");

    updateStep("Controversy Specialist", "running");
    const controversyDone = await callAgent("controversy-specialist", {
      weapons_done: weaponsDone,
      brief,
    });
    session.outputs["controversy_done"] = controversyDone;
    updateStep("Controversy Specialist", "completed");

    updateStep("Technical Specialist", "running");
    const technicalDone = await callAgent("technical-specialist", {
      controversy_done: controversyDone,
      brief,
      fathom_transcript: brandInfo.fathomTranscript || "",
    });
    session.outputs["technical_done"] = technicalDone;
    updateStep("Technical Specialist", "completed");

    updateStep("Flow Specialist", "running");
    const flowDone = await callAgent("flow-specialist", {
      technical_done: technicalDone,
      hooks_approved: hooksApproved,
      brief,
    });
    session.outputs["flow_done"] = flowDone;
    updateStep("Flow Specialist", "completed");

    // Body Manager (FINAL GATE)
    updateStep("Body Manager", "running");
    const bodyFinal = await callAgent("body-manager", {
      flow_done: flowDone,
      brief,
    });
    session.outputs["body_final"] = bodyFinal;
    updateStep("Body Manager", "completed");

    // ── PHASE 5: Quality + Deliver ──
    emit("progress", undefined, undefined, "Running quality checks...");

    // Mom Test + Call Supervisor (parallel)
    const [momTestResult, callSupervisorResult] = await Promise.all([
      (async () => {
        updateStep("Mom Test", "running");
        const result = await callAgent("mom-test", {
          full_script: `${hooksApproved}\n\n${bodyFinal}\n\n${giveawayApproved}`,
        });
        session.outputs["mom_test"] = result;
        updateStep("Mom Test", "completed");
        return result;
      })(),

      (async () => {
        updateStep("Call Supervisor", "running");
        const result = await callAgent("call-supervisor", {
          brief,
          full_script: `${hooksApproved}\n\n${bodyFinal}\n\n${giveawayApproved}`,
        });
        session.outputs["call_supervisor"] = result;
        updateStep("Call Supervisor", "completed");
        return result;
      })(),
    ]);

    // Final Review
    updateStep("Final Review", "running");
    const finalScript = await callAgent("final-review", {
      hooks_approved: hooksApproved,
      body_final: bodyFinal,
      giveaway_approved: giveawayApproved,
      brief,
      mom_test_feedback: momTestResult,
      call_supervisor_feedback: callSupervisorResult,
    });
    session.outputs["final_script"] = finalScript;
    updateStep("Final Review", "completed");

    // Deliver to Google Doc
    updateStep("Deliver", "running");
    if (session.googleDocId) {
      try {
        await writeFinalScript(
          session.googleDocId,
          brandInfo.brandName,
          hooksApproved,
          bodyFinal,
          giveawayApproved
        );
      } catch (err) {
        console.error("[Pipeline] Google Docs final write failed:", err);
      }
    }
    updateStep("Deliver", "completed");

    session.status = "completed";
    emit("done", undefined, undefined, "Pipeline complete!");
  } catch (err) {
    session.status = "failed";
    const errMsg = err instanceof Error ? err.message : String(err);
    emit("error", undefined, undefined, errMsg);
    console.error("[Pipeline] Fatal error:", err);
  }

  // Durably persist the terminal state (awaited so it isn't lost to a race).
  try {
    await saveSession(session);
  } catch (e) {
    console.error("[db] final persist failed:", e instanceof Error ? e.message : e);
  }

  return session;
}
