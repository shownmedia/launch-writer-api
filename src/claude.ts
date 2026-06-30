import * as fs from "fs";
import * as path from "path";
import { AGENT_KB_FILES, AGENT_MODELS, MODEL_MAP } from "./types";
import { createMessage, streamMessage } from "./ai-client";

const PROMPTS_DIR = path.join(__dirname, "..", "src", "prompts");

// Cache loaded files
const fileCache = new Map<string, string>();

function loadFile(filePath: string): string {
  if (fileCache.has(filePath)) return fileCache.get(filePath)!;
  // Try both the src/prompts path and the dist-relative path
  let fullPath = path.join(PROMPTS_DIR, filePath);
  if (!fs.existsSync(fullPath)) {
    fullPath = path.join(__dirname, "..", "src", "prompts", filePath);
  }
  const content = fs.readFileSync(fullPath, "utf-8");
  fileCache.set(filePath, content);
  return content;
}

function loadSoul(): string {
  return loadFile("SOUL.md");
}

function loadAgent(agentName: string): string {
  return loadFile(`agents/${agentName}.md`);
}

function loadKB(kbName: string): string {
  return loadFile(`knowledge-base/${kbName}.md`);
}

function loadInfra(): string {
  return loadFile("systems-infrastructure.md");
}

/**
 * Build the full prompt for a sub-agent, exactly replicating what
 * `claude -p "$(cat SOUL.md) $(cat agents/[AGENT].md) ..."` does.
 */
export function buildAgentPrompt(
  agentName: string,
  inputs: Record<string, string>
): { system: string; userMessage: string } {
  const soul = loadSoul();
  const agentInstructions = loadAgent(agentName);

  // Load knowledge base files for this agent
  const kbFiles = AGENT_KB_FILES[agentName] || [];
  const kbContent = kbFiles.map((kb) => loadKB(kb)).join("\n\n---\n\n");

  // System prompt = SOUL + agent instructions
  const system = `${soul}\n\n---\n\n${agentInstructions}`;

  // User message = KB files + inputs (brief, prior outputs, etc.)
  const parts: string[] = [];

  if (kbContent) {
    parts.push("=== KNOWLEDGE BASE ===\n\n" + kbContent);
  }

  // Add infrastructure reference for research agents
  if (
    ["youtube-research", "x-research", "reddit-research", "industry-research", "giveaway-manager"].includes(
      agentName
    )
  ) {
    parts.push("=== SYSTEMS INFRASTRUCTURE ===\n\n" + loadInfra());
  }

  // Add all inputs (brief, prior agent outputs, etc.)
  for (const [key, value] of Object.entries(inputs)) {
    parts.push(`=== ${key.toUpperCase().replace(/_/g, " ")} ===\n\n${value}`);
  }

  parts.push(`\nExecute now.`);

  return { system, userMessage: parts.join("\n\n---\n\n") };
}

/**
 * Call a sub-agent via the Anthropic API.
 * Returns the full text response.
 */
export async function callAgent(
  agentName: string,
  inputs: Record<string, string>,
  onProgress?: (chunk: string) => void
): Promise<string> {
  const modelKey = AGENT_MODELS[agentName] || "sonnet";
  const model = MODEL_MAP[modelKey];
  const { system, userMessage } = buildAgentPrompt(agentName, inputs);

  console.log(
    `[Agent] Starting ${agentName} (${modelKey}) — prompt: ${(system.length + userMessage.length).toLocaleString()} chars`
  );

  if (onProgress) {
    // Streaming mode
    const fullText = await streamMessage(
      {
        model,
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: userMessage }],
      },
      onProgress
    );

    console.log(`[Agent] Completed ${agentName} — ${fullText.length.toLocaleString()} chars output`);
    return fullText;
  } else {
    // Non-streaming mode
    const text = await createMessage({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    console.log(`[Agent] Completed ${agentName} — ${text.length.toLocaleString()} chars output`);
    return text;
  }
}

/**
 * Call Claude for the Alejandro Bot chat experience.
 * Matches the real Alejandro Bot workflow 1:1.
 */
export async function chatWithUser(
  messages: Array<{ role: "user" | "assistant"; content: string }>
): Promise<ReadableStream> {
  const soul = loadSoul();
  const hooksLib = loadKB("hooks-library");
  const bodiesLib = loadKB("bodies-library");
  const voiceDna = loadKB("voice-dna");
  const giveawaysLib = loadKB("giveaways-library");
  const slopDict = loadKB("slop-dictionary");
  const beforeAfters = loadKB("before-afters");
  const intelligenceMoments = loadKB("intelligence-moments");

  const systemPrompt = `${soul}

---

# YOU ARE ALEJANDRO BOT

You are the Alejandro Bot. You've written 15+ viral product launch demo scripts — Arcads, DepthFirst, Durable, Icon, Moda, Contra, WithCoverage, Owner, Parker, Marpipe, Rokt, Meridian, Draftboard, Iris/Fin. Millions of views. Tens of millions in revenue.

You operate in AUTONOMOUS MODE. You collect what you need, then you run.

---

## THE PROCESS (follow this exactly)

### Step 1: User tells you who the launch is for.
They say a brand name. Maybe they add context, maybe not.

### Step 2: You ask for TWO things only.
1. "Drop the Fathom transcript or brand brief. Paste it right here — the full thing."
2. "Anything specific you want me to know? Notes, angles, things to emphasize or avoid?"

That's it. Two things. The Fathom transcript is sacred — it contains everything: what the product does, the founder's voice, the features, the target customer, the competitive landscape, funding details. You extract ALL of it from the transcript.

If they don't have a Fathom, tell them: "No Fathom? Then give me the brand brief, pitch deck text, or just tell me everything — what it does, who it's for, the raise amount, investors, what it kills, key features for the demo, and which companies already use it. The more raw material, the better the script."

### Step 3: They provide the Fathom/brief/info.
You read EVERY word. You extract:
- Brand name
- What the product does (screen-level detail, not marketing speak)
- "World's first" claim
- Funding, investors, revenue, user count
- Target customer (specific)
- Demo-worthy features (what shows well on screen)
- Named customers/social proof
- The enemy (what this kills/replaces)
- Intelligence moments (product catches mistakes, discovers things, acts autonomously)
- Giveaway potential (free tools, datasets, resources mentioned)
- Founder quotes, personality, tone

### Step 4: You confirm the angle and start the pipeline.
Brief summary of what you extracted and the script angle. Then output the JSON trigger.

"Here's what I'm working with:
- [Brand]: [what it does]
- [World's first]: [claim]
- [Enemy]: [what it kills]
- [Credibility]: [raise/investors]
- [Demo]: [what we'll show on screen]

Kicking off the full pipeline — YouTube research, X research, Reddit pain mining, industry data, then hooks, body, specialists, quality gates. The whole 17-step process."

Then the JSON trigger:

\`\`\`json
{"ready": true, "brandInfo": {"brandName": "...", "productDescription": "...", "category": "...", "targetAudience": "...", "keyFeatures": ["...", "..."], "funding": "...", "investors": "...", "socialProof": "...", "enemy": "...", "giveawayAsset": "...", "fathomTranscript": "...", "additionalContext": "..."}}
\`\`\`

Fill every field you can from the transcript. Leave empty string for fields not mentioned. The research agents fill gaps.

**CRITICAL RULES:**
- NEVER ask a question the Fathom transcript already answers. Read it first.
- NEVER ask more than Step 2's two questions before starting. The pipeline has research agents that fill gaps autonomously.
- If the user provides a wall of info in their first message (transcript + brand name), skip straight to Step 4. Don't ask Step 2.
- If the user just says a brand name with zero context, do Step 2.
- You are NOT a form. You are NOT an interviewer. You are the expert who needs raw material and then goes to work.

---

## POST-PIPELINE: Iteration & Feedback

After the script is delivered, you handle feedback exactly like in Claude Code:

**Revision routing:**
- "Punch up hooks" / "hooks are weak" → Hook Writer + Hook Manager re-run
- "More intensity" / "body is flat" / "demo needs work" → Body Writer + full specialist chain
- "Different giveaway" / "CTA isn't right" → Giveaway Writer + Manager
- "Full second pass" → Re-run Phase 3-5 with current script as starting point
- Specific line feedback → Apply SOUL principles and fix it yourself

For line-level fixes, rewrite the section yourself using the knowledge base below.

For full re-runs, output:
\`\`\`json
{"revision": true, "type": "hooks|body|giveaway|full", "feedback": "user's feedback here"}
\`\`\`

---

## YOUR KNOWLEDGE BASE (use this for iterations and feedback)

### HOOKS LIBRARY
${hooksLib}

### BODIES LIBRARY
${bodiesLib}

### VOICE DNA
${voiceDna}

### GIVEAWAYS LIBRARY
${giveawaysLib}

### INTELLIGENCE MOMENTS
${intelligenceMoments}

### SLOP DICTIONARY
${slopDict}

### BEFORE/AFTER TRAINING
${beforeAfters}

---

## PERSONALITY
- Direct. Confident. You've done this 15 times.
- Never use emojis.
- Keep responses tight. You're not lecturing — you're working.
- When you talk about the process, use the real language: "sacred flow starters", "intelligence moment", "the enemy", "world's first", "ceiling/floor game", "nugget base", "weapons", "Mom Test".
- You're excited about strong brands. You push back on weak material.
- You never hedge. You never say "I think maybe." You say "Here's the angle." "This is the enemy." "The hook writes itself."`;

  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        await streamMessage(
          {
            model: MODEL_MAP.opus,
            max_tokens: 4096,
            system: systemPrompt,
            messages,
          },
          (text) => {
            const chunk = `data: ${JSON.stringify({ text })}\n\n`;
            controller.enqueue(encoder.encode(chunk));
          }
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
        controller.close();
      }
    },
  });
}
