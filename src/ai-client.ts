/**
 * Unified AI client with Anthropic → OpenAI fallback.
 *
 * The team's Anthropic org was disabled at the platform level (a Trust & Safety
 * action, not billing), which returns errors on every `messages.create` /
 * `messages.stream` call and takes the launch pipeline down. This wrapper mirrors
 * the small subset of the Anthropic SDK this service uses (system + plain-text
 * messages, streaming and non-streaming) and falls back to OpenAI Chat
 * Completions on failure.
 *
 * Provider selection via the AI_PROVIDER env var:
 *   - openai    → use OpenAI only (skip the failing Anthropic call)
 *   - anthropic → use Anthropic only (no fallback)
 *   - unset     → try Anthropic, fall back to OpenAI on any error
 *
 * When Anthropic is reinstated, unset AI_PROVIDER and calls auto-recover.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { OPENAI_MODEL_MAP } from "./types";

export interface AiParams {
  /** Anthropic model id — mapped to an OpenAI model on fallback. */
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

const OPENAI_DEFAULT_MODEL = process.env.OPENAI_DEFAULT_MODEL || "gpt-4o";

// Reasoning models (gpt-5.x, o-series) count hidden reasoning tokens against
// max_completion_tokens. With a small cap the reasoning phase can consume the
// entire budget, leaving zero tokens for visible output — the root cause of
// blank hooks/managers in the pipeline. We cap reasoning effort AND give the
// completion budget generous headroom so output always has room. Both are
// env-tunable without a code change.
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "low";
const OPENAI_MIN_COMPLETION_TOKENS =
  Number(process.env.OPENAI_MAX_COMPLETION_TOKENS) || 16000;
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 180000;

function openaiCompletionTokens(requested: number): number {
  return Math.max(requested, OPENAI_MIN_COMPLETION_TOKENS);
}

// Only reasoning-model families accept `reasoning_effort`; sending it to a
// non-reasoning model (e.g. gpt-4o) is a 400. Gate on the model id.
function supportsReasoning(model: string): boolean {
  return /^(gpt-5|o1|o3|o4)/i.test(model);
}

function providerOverride(): string | undefined {
  return process.env.AI_PROVIDER?.trim().toLowerCase();
}

function hasAnthropic(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function hasOpenAI(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

function openaiModelFor(anthropicModel: string): string {
  return OPENAI_MODEL_MAP[anthropicModel] || OPENAI_DEFAULT_MODEL;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected AI provider error";
}

let anthropicClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return anthropicClient;
}

let openaiClient: OpenAI | null = null;
function openai(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      timeout: OPENAI_TIMEOUT_MS,
    });
  }
  return openaiClient;
}

// --- Non-streaming ----------------------------------------------------------

async function anthropicCreate(params: AiParams): Promise<string> {
  const response = await anthropic().messages.create({
    model: params.model,
    max_tokens: params.max_tokens,
    system: params.system,
    messages: params.messages,
  });
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function openaiCreateOnce(params: AiParams, effort: string): Promise<string> {
  const model = openaiModelFor(params.model);
  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model,
    max_completion_tokens: openaiCompletionTokens(params.max_tokens),
    messages: [
      { role: "system", content: params.system },
      ...params.messages,
    ],
  };
  if (supportsReasoning(model)) {
    body.reasoning_effort = effort as typeof body.reasoning_effort;
  }
  const completion = await openai().chat.completions.create(body);
  return completion.choices[0]?.message?.content ?? "";
}

async function openaiCreate(params: AiParams): Promise<string> {
  const text = await openaiCreateOnce(params, OPENAI_REASONING_EFFORT);
  if (text.trim()) return text;
  // Empty output: on reasoning models the reasoning phase can consume the whole
  // completion budget. Retry once with minimal reasoning so output has room.
  console.error(
    `[ai-client] OpenAI returned empty output (${openaiModelFor(params.model)}); retrying with minimal reasoning`
  );
  return openaiCreateOnce(params, "minimal");
}

/**
 * Generate a full text response with automatic Anthropic → OpenAI fallback.
 */
export async function createMessage(params: AiParams): Promise<string> {
  const forced = providerOverride();

  if (forced === "openai") {
    if (!hasOpenAI()) throw new Error("OPENAI_API_KEY not configured");
    return openaiCreate(params);
  }
  if (forced === "anthropic") {
    if (!hasAnthropic()) throw new Error("ANTHROPIC_API_KEY not configured");
    return anthropicCreate(params);
  }

  if (hasAnthropic()) {
    try {
      return await anthropicCreate(params);
    } catch (error) {
      if (!hasOpenAI()) throw error;
      console.error(`[ai-client] Anthropic failed, falling back to OpenAI: ${errMsg(error)}`);
      return openaiCreate(params);
    }
  }
  if (hasOpenAI()) return openaiCreate(params);
  throw new Error("No AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY)");
}

// --- Streaming --------------------------------------------------------------

async function anthropicStream(
  params: AiParams,
  onDelta: (text: string) => void
): Promise<string> {
  let full = "";
  const stream = anthropic().messages.stream({
    model: params.model,
    max_tokens: params.max_tokens,
    system: params.system,
    messages: params.messages,
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      full += event.delta.text;
      onDelta(event.delta.text);
    }
  }
  return full;
}

async function openaiStreamOnce(
  params: AiParams,
  effort: string,
  onDelta: (text: string) => void
): Promise<string> {
  let full = "";
  const model = openaiModelFor(params.model);
  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model,
    max_completion_tokens: openaiCompletionTokens(params.max_tokens),
    stream: true,
    messages: [
      { role: "system", content: params.system },
      ...params.messages,
    ],
  };
  if (supportsReasoning(model)) {
    body.reasoning_effort = effort as typeof body.reasoning_effort;
  }
  const stream = await openai().chat.completions.create(body);
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      full += delta;
      onDelta(delta);
    }
  }
  return full;
}

async function openaiStream(
  params: AiParams,
  onDelta: (text: string) => void
): Promise<string> {
  const full = await openaiStreamOnce(params, OPENAI_REASONING_EFFORT, onDelta);
  if (full.trim()) return full;
  // Nothing streamed — reasoning likely consumed the budget. Retry once with
  // minimal reasoning. Safe: no text reached the caller, so no duplication.
  console.error(
    `[ai-client] OpenAI streamed empty output (${openaiModelFor(params.model)}); retrying with minimal reasoning`
  );
  return openaiStreamOnce(params, "minimal", onDelta);
}

/**
 * Stream a text response, invoking `onDelta` for each text chunk, with
 * automatic Anthropic → OpenAI fallback. Returns the full concatenated text.
 *
 * Fallback only triggers if Anthropic fails *before* emitting any text, so a
 * partial stream is never duplicated across providers.
 */
export async function streamMessage(
  params: AiParams,
  onDelta: (text: string) => void
): Promise<string> {
  const forced = providerOverride();

  if (forced === "openai") {
    if (!hasOpenAI()) throw new Error("OPENAI_API_KEY not configured");
    return openaiStream(params, onDelta);
  }
  if (forced === "anthropic") {
    if (!hasAnthropic()) throw new Error("ANTHROPIC_API_KEY not configured");
    return anthropicStream(params, onDelta);
  }

  if (hasAnthropic()) {
    let emitted = false;
    const guarded = (text: string) => {
      emitted = true;
      onDelta(text);
    };
    try {
      return await anthropicStream(params, guarded);
    } catch (error) {
      if (emitted || !hasOpenAI()) throw error;
      console.error(`[ai-client] Anthropic stream failed, falling back to OpenAI: ${errMsg(error)}`);
      return openaiStream(params, onDelta);
    }
  }
  if (hasOpenAI()) return openaiStream(params, onDelta);
  throw new Error("No AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY)");
}
