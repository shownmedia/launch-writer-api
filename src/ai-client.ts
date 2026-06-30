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
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
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

async function openaiCreate(params: AiParams): Promise<string> {
  const completion = await openai().chat.completions.create({
    model: openaiModelFor(params.model),
    max_completion_tokens: params.max_tokens,
    messages: [
      { role: "system", content: params.system },
      ...params.messages,
    ],
  });
  return completion.choices[0]?.message?.content ?? "";
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

async function openaiStream(
  params: AiParams,
  onDelta: (text: string) => void
): Promise<string> {
  let full = "";
  const stream = await openai().chat.completions.create({
    model: openaiModelFor(params.model),
    max_completion_tokens: params.max_tokens,
    stream: true,
    messages: [
      { role: "system", content: params.system },
      ...params.messages,
    ],
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      full += delta;
      onDelta(delta);
    }
  }
  return full;
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
