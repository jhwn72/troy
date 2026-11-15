// Types for _handler.js, so the build script, the local runner and the tests can import it.

export interface SimPattern {
  source: string;
  flags: string;
}

export interface SimData {
  /** The whole fixed system prompt: persona, about, playbook and the simulator brief. */
  system: string;
  fixed: { emergency: string[]; crisis: string[]; stop: string[]; start: string[]; noContact: string; welcome?: { bubbles: string[]; question: string }[]; welcomeOptions?: string[] };
  patterns: { emergency: SimPattern[]; crisis: SimPattern[]; laughWords: SimPattern; laughEmoji: SimPattern; smallCause: SimPattern; conditional: SimPattern };
  stopWords: string[];
  startWords: string[];
}

export interface SimMessage {
  from: "me" | "troy";
  text?: string;
  imageBase64?: string;
  imageMime?: string;
  vote?: { question: string; option: string };
  reaction?: { type: string; onText: string };
  poll?: { question: string; options: string[] };
  photo?: true;
  location?: "near campus" | "not near campus";
  sig?: string;
}

export interface SimReply {
  ok: true;
  bubbles: { text: string; effect?: string; sig?: string }[];
  poll?: { question: string; options: string[]; sig?: string };
  tapback?: { type: string; onLast: true };
  card?: true;
  example?: string;
  fixed?: "emergency" | "crisis" | "stop" | "start";
  ended?: true;
}

export type ModelCall = (input: { system: string; messages: { role: "user" | "assistant"; content: unknown }[]; apiKey: string | undefined }) => Promise<unknown>;

export const SITUATIONS: string[];
export function signTurn(key: Buffer | null, m: { text?: string; poll?: { question: string; options: string[] } }): string;
export function turnKeyFor(env: Record<string, string | undefined>): Buffer | null;
export function typed(text: string): string;
export const LIMITS: {
  windowMs: number;
  perIp: number;
  perInstance: number;
  inFlight: number;
  bodyBytes: number;
  messages: number;
  mine: number;
  textChars: number;
  imageBytes: number;
  sentToModel: number;
  maxTokens: number;
  timeoutMs: number;
  bubbles: number;
  welcomeBubbles: number;
  bubbleChars: number;
  pollOptions: number;
  pollOptionChars: number;
  pollQuestionChars: number;
  exampleChars: number;
};
export const MODEL: string;
export const REPLY_SCHEMA: Record<string, unknown>;
export function clean(text: string): string;
export function polish(text: string): string;
export function splitLong(text: string, max?: number): string[];
export function fixedKind(text: unknown, data: SimData): "crisis" | "emergency" | "stop" | "start" | null;
export function readBody(body: unknown): { messages: SimMessage[]; situation: string } | "bad_request" | "limit";
export function toApiMessages(messages: SimMessage[], situation: string): { role: "user" | "assistant"; content: unknown }[];
export function allowedContacts(system: string): Set<string>;
export function clampReply(raw: unknown, data: SimData, allowed?: Set<string>): SimReply | null;
export const callClaude: ModelCall;
export function createSimHandler(opts: { data: SimData; callModel?: ModelCall; env?: Record<string, string | undefined>; now?: () => number }): (request: Request) => Promise<Response>;
