export type AgentModel = "opus" | "sonnet";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface PipelineStep {
  id: string;
  name: string;
  agent: string;
  model: AgentModel;
  status: StepStatus;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface LaunchSession {
  id: string;
  brandName: string;
  status: "collecting_info" | "running" | "completed" | "failed";
  createdAt: Date;
  updatedAt: Date;
  googleDocId?: string;
  googleDocUrl?: string;
  driveFolderId?: string;

  // Pipeline state
  steps: PipelineStep[];
  currentStep: number;

  // Outputs (keyed by filename)
  outputs: Record<string, string>;

  // Brand info from chat
  brandInfo: BrandInfo;
}

export interface BrandInfo {
  brandName: string;
  productDescription?: string;
  category?: string;
  targetAudience?: string;
  keyFeatures?: string[];
  funding?: string;
  investors?: string;
  socialProof?: string;
  enemy?: string;
  giveawayAsset?: string;
  fathomTranscript?: string;
  additionalContext?: string;
}

export interface SSEEvent {
  type: "step_update" | "progress" | "output" | "error" | "done";
  data: unknown;
}

export const MODEL_MAP: Record<AgentModel, string> = {
  // Use rolling, non-dated aliases — pinned `-YYYYMMDD` snapshots get retired by
  // Anthropic and then 404 at request time.
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
};

/**
 * OpenAI fallback models, keyed by the Anthropic model id they stand in for.
 * Used by src/ai-client.ts when Anthropic fails or AI_PROVIDER=openai. Default
 * gpt-4o, overridable via env so the model can change without a code edit.
 */
export const OPENAI_MODEL_MAP: Record<string, string> = {
  [MODEL_MAP.opus]: process.env.OPENAI_OPUS_MODEL || "gpt-4o",
  [MODEL_MAP.sonnet]: process.env.OPENAI_SONNET_MODEL || "gpt-4o",
};

// Agent → model routing (from SKILL.md)
export const AGENT_MODELS: Record<string, AgentModel> = {
  "research-agent": "sonnet",
  "youtube-research": "sonnet",
  "x-research": "sonnet",
  "reddit-research": "sonnet",
  "industry-research": "sonnet",
  "research-compiler": "sonnet",
  "hook-writer": "opus",
  "hook-manager": "opus",
  "giveaway-writer": "opus",
  "giveaway-manager": "opus",
  "body-writer": "opus",
  "weapons-specialist": "opus",
  "controversy-specialist": "opus",
  "technical-specialist": "opus",
  "flow-specialist": "opus",
  "body-manager": "opus",
  "fathom-checker": "opus",
  "mom-test": "sonnet",
  "call-supervisor": "sonnet",
  "final-review": "opus",
};

// Which KB files each agent needs (from SKILL.md table)
export const AGENT_KB_FILES: Record<string, string[]> = {
  "research-agent": [],
  "youtube-research": [],
  "x-research": [],
  "reddit-research": [],
  "industry-research": [],
  "research-compiler": [],
  "hook-writer": ["hooks-library", "voice-dna", "before-afters"],
  "hook-manager": ["hooks-library", "before-afters", "scoring-rubrics"],
  "giveaway-writer": ["giveaways-library", "voice-dna", "before-afters"],
  "giveaway-manager": ["giveaways-library", "scoring-rubrics"],
  "body-writer": ["bodies-library", "voice-dna", "intelligence-moments", "before-afters"],
  "weapons-specialist": ["weapons-library", "scoring-rubrics"],
  "controversy-specialist": ["weapons-library", "scoring-rubrics"],
  "technical-specialist": ["scoring-rubrics"],
  "flow-specialist": ["voice-dna", "slop-dictionary", "bodies-library", "scoring-rubrics"],
  "body-manager": ["bodies-library", "before-afters", "scoring-rubrics"],
  "fathom-checker": [],
  "mom-test": [],
  "call-supervisor": [],
  "final-review": [
    "hooks-library", "bodies-library", "giveaways-library", "voice-dna",
    "intelligence-moments", "before-afters", "slop-dictionary", "weapons-library",
    "scoring-rubrics", "viral-formats",
  ],
};
