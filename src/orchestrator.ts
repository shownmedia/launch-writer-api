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

  // Names of steps that degraded (see safeAgent) — surfaced at the top of the
  // final script so the user knows exactly what to review or rerun.
  const warnings: string[] = [];

  // Run a single-agent step with graceful degradation. On failure the step is
  // marked "failed" (NOT thrown), a warning is recorded, and `fallback` is
  // returned — so one bad or slow agent can't abort the whole 8+ minute run.
  const safeAgent = async (
    name: string,
    agent: string,
    inputs: Record<string, string>,
    fallback: string
  ): Promise<string> => {
    updateStep(name, "running");
    try {
      const result = await callAgent(agent, inputs);
      updateStep(name, "completed");
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] ${name} failed — degrading:`, msg);
      warnings.push(name);
      updateStep(name, "failed", msg);
      return fallback;
    }
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
    const researchFallback = [
      session.outputs["youtube_research"],
      session.outputs["x_research"],
      session.outputs["reddit_pain"],
      session.outputs["industry_data"],
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");
    const researchBrief = await safeAgent(
      "Research Compiler",
      "research-compiler",
      {
        brief,
        youtube_research: session.outputs["youtube_research"] || "",
        x_research: session.outputs["x_research"] || "",
        reddit_pain: session.outputs["reddit_pain"] || "",
        industry_data: session.outputs["industry_data"] || "",
      },
      researchFallback
    );
    session.outputs["research_brief"] = researchBrief;

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
        const result = await safeAgent(
          "Hook Writer",
          "hook-writer",
          { brief, research_brief: researchBrief },
          "[Hook generation failed — please rerun the hooks.]"
        );
        session.outputs["hooks_draft"] = result;
        return result;
      })(),

      // Track B: Giveaway Writer
      (async () => {
        const result = await safeAgent(
          "Giveaway Writer",
          "giveaway-writer",
          { brief, research_brief: researchBrief },
          "[Giveaway generation failed — please rerun the giveaway.]"
        );
        session.outputs["giveaway_draft"] = result;
        return result;
      })(),
    ]);

    // Managers (parallel) — on failure fall back to the unreviewed draft.
    const [hooksApproved, giveawayApproved] = await Promise.all([
      (async () => {
        const result = await safeAgent(
          "Hook Manager",
          "hook-manager",
          { hooks_draft: hooksDraft, brief },
          hooksDraft
        );
        session.outputs["hooks_approved"] = result;
        return result;
      })(),

      (async () => {
        const result = await safeAgent(
          "Giveaway Manager",
          "giveaway-manager",
          { giveaway_draft: giveawayDraft, brief },
          giveawayDraft
        );
        session.outputs["giveaway_approved"] = result;
        return result;
      })(),
    ]);

    // ── PHASE 4: Body (sequential chain) ──
    emit("progress", undefined, undefined, "Writing body...");

    const bodyDraft = await safeAgent(
      "Body Writer",
      "body-writer",
      { brief, research_brief: researchBrief, hooks_approved: hooksApproved },
      "[Body generation failed — please rerun the body.]"
    );
    session.outputs["body_draft"] = bodyDraft;

    // Specialists chain (sequential — each builds on the last). On failure a
    // specialist passes the previous stage through unchanged, so the chain
    // continues instead of aborting.
    const weaponsDone = await safeAgent(
      "Weapons Specialist",
      "weapons-specialist",
      { body_draft: bodyDraft, brief },
      bodyDraft
    );
    session.outputs["weapons_done"] = weaponsDone;

    const controversyDone = await safeAgent(
      "Controversy Specialist",
      "controversy-specialist",
      { weapons_done: weaponsDone, brief },
      weaponsDone
    );
    session.outputs["controversy_done"] = controversyDone;

    const technicalDone = await safeAgent(
      "Technical Specialist",
      "technical-specialist",
      {
        controversy_done: controversyDone,
        brief,
        fathom_transcript: brandInfo.fathomTranscript || "",
      },
      controversyDone
    );
    session.outputs["technical_done"] = technicalDone;

    const flowDone = await safeAgent(
      "Flow Specialist",
      "flow-specialist",
      { technical_done: technicalDone, hooks_approved: hooksApproved, brief },
      technicalDone
    );
    session.outputs["flow_done"] = flowDone;

    // Body Manager (FINAL GATE) — on failure fall back to the unreviewed body.
    const bodyFinal = await safeAgent(
      "Body Manager",
      "body-manager",
      { flow_done: flowDone, brief },
      flowDone
    );
    session.outputs["body_final"] = bodyFinal;

    // ── PHASE 5: Quality + Deliver ──
    emit("progress", undefined, undefined, "Running quality checks...");

    // Mom Test + Call Supervisor (parallel) — advisory only; skip on failure.
    const [momTestResult, callSupervisorResult] = await Promise.all([
      (async () => {
        const result = await safeAgent(
          "Mom Test",
          "mom-test",
          { full_script: `${hooksApproved}\n\n${bodyFinal}\n\n${giveawayApproved}` },
          ""
        );
        session.outputs["mom_test"] = result;
        return result;
      })(),

      (async () => {
        const result = await safeAgent(
          "Call Supervisor",
          "call-supervisor",
          {
            brief,
            full_script: `${hooksApproved}\n\n${bodyFinal}\n\n${giveawayApproved}`,
          },
          ""
        );
        session.outputs["call_supervisor"] = result;
        return result;
      })(),
    ]);

    // Final Review — on failure fall back to the assembled sections directly.
    const finalScript = await safeAgent(
      "Final Review",
      "final-review",
      {
        hooks_approved: hooksApproved,
        body_final: bodyFinal,
        giveaway_approved: giveawayApproved,
        brief,
        mom_test_feedback: momTestResult,
        call_supervisor_feedback: callSupervisorResult,
      },
      `${hooksApproved}\n\n${bodyFinal}\n\n${giveawayApproved}`
    );
    session.outputs["final_script"] = finalScript;

    // Persist the script immediately (awaited) BEFORE the fallible Deliver step.
    // Final Review's own step-persist ran before this assignment, so without
    // this a crash/restart during the Google-Docs write below would lose the
    // finished script even though it exists in memory.
    try {
      await saveSession(session);
    } catch (e) {
      console.error("[db] final_script persist failed:", e instanceof Error ? e.message : e);
    }

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

    // If any step degraded, flag it at the top of the script so the user knows
    // exactly what to review or rerun (the run still delivers a usable draft).
    if (warnings.length) {
      const banner = `⚠️ These sections had errors and may need a rerun: ${warnings.join(", ")}\n\n---\n\n`;
      session.outputs["final_script"] = banner + (session.outputs["final_script"] || "");
      session.outputs["_warnings"] = warnings.join(", ");
    }

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
