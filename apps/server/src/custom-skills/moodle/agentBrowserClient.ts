// @effect-diagnostics nodeBuiltinImport:off
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MoodleRuntimeConfig } from "./types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_AGENT_BROWSER_PACKAGE = "agent-browser@0.27.0";

export interface AgentBrowserClient {
  doctor(): Promise<AgentBrowserCommandResult>;
  open(url: string): Promise<AgentBrowserCommandResult>;
  snapshot(options?: SnapshotOptions): Promise<AgentBrowserSnapshot>;
  getText(selector?: string): Promise<string>;
  getTitle(): Promise<string>;
  getUrl(): Promise<string>;
  evalJson<T = unknown>(script: string): Promise<T>;
  fill(selector: string, value: string): Promise<AgentBrowserCommandResult>;
  click(selector: string): Promise<AgentBrowserCommandResult>;
  press(key: string): Promise<AgentBrowserCommandResult>;
  wait(ms: number): Promise<AgentBrowserCommandResult>;
  download(selector: string, targetPath: string): Promise<AgentBrowserCommandResult>;
  close(): Promise<AgentBrowserCommandResult>;
}

export interface AgentBrowserCommandResult {
  stdout: string;
  stderr: string;
}

export interface SnapshotOptions {
  interactive?: boolean;
  urls?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
}

export interface AgentBrowserSnapshot {
  origin: string;
  refs: Record<string, AgentBrowserRef>;
  snapshot: string;
}

export interface AgentBrowserRef {
  role?: string;
  name?: string;
}

interface AgentBrowserJsonEnvelope {
  success?: boolean;
  data?: AgentBrowserSnapshot;
  error?: unknown;
}

interface CommandSpec {
  command: string;
  baseArgs: string[];
  sensitiveValues: string[];
}

export class AgentBrowserCommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(input: { message: string; stdout: string; stderr: string; exitCode: number | null }) {
    super(input.message);
    this.name = "AgentBrowserCommandError";
    this.stdout = input.stdout;
    this.stderr = input.stderr;
    this.exitCode = input.exitCode;
  }
}

export function createAgentBrowserClient(config: MoodleRuntimeConfig): AgentBrowserClient {
  const spec = buildAgentBrowserCommandSpec(config);
  return new CliAgentBrowserClient(spec);
}

export function buildAgentBrowserCommandSpec(config: MoodleRuntimeConfig): CommandSpec {
  const command = config.agentBrowserBin || "npx";
  const baseArgs = config.agentBrowserBin
    ? []
    : ["-y", process.env.AGENT_BROWSER_PACKAGE || DEFAULT_AGENT_BROWSER_PACKAGE];
  if (config.browserSession) {
    baseArgs.push("--session", config.browserSession);
  }
  if (config.browserSessionName) {
    baseArgs.push("--session-name", config.browserSessionName);
  }
  if (config.browserAllowedDomains?.length) {
    baseArgs.push("--allowed-domains", config.browserAllowedDomains.join(","));
  }
  if (config.browserActionPolicyPath) {
    baseArgs.push("--action-policy", config.browserActionPolicyPath);
  }
  if (config.browserMaxOutput) {
    baseArgs.push("--max-output", String(config.browserMaxOutput));
  }
  if (!config.headless) {
    baseArgs.push("--headed");
  }
  baseArgs.push("--content-boundaries");

  return {
    command,
    baseArgs,
    sensitiveValues: [
      config.username,
      config.password,
      config.cisUsername,
      config.cisPassword,
    ].filter((value): value is string => Boolean(value)),
  };
}

export async function verifyAgentBrowserPolicy(config: MoodleRuntimeConfig): Promise<void> {
  if (!config.browserActionPolicyPath) {
    return;
  }
  await access(config.browserActionPolicyPath);
}

class CliAgentBrowserClient implements AgentBrowserClient {
  private readonly spec: CommandSpec;

  constructor(spec: CommandSpec) {
    this.spec = spec;
  }

  async doctor(): Promise<AgentBrowserCommandResult> {
    return this.run(["doctor", "--offline", "--quick", "--json"]);
  }

  async open(url: string): Promise<AgentBrowserCommandResult> {
    return this.run(["open", url]);
  }

  async snapshot(options: SnapshotOptions = {}): Promise<AgentBrowserSnapshot> {
    const args = ["snapshot", "--json"];
    if (options.interactive) {
      args.push("--interactive");
    }
    if (options.urls) {
      args.push("--urls");
    }
    if (options.compact) {
      args.push("--compact");
    }
    if (options.depth !== undefined) {
      args.push("--depth", String(options.depth));
    }
    if (options.selector) {
      args.push("--selector", options.selector);
    }
    const result = await this.run(args);
    return parseAgentBrowserSnapshot(result.stdout);
  }

  async getText(selector = "body"): Promise<string> {
    return (await this.run(["get", "text", selector])).stdout.trim();
  }

  async getTitle(): Promise<string> {
    return (await this.run(["get", "title"])).stdout.trim();
  }

  async getUrl(): Promise<string> {
    return (await this.run(["get", "url"])).stdout.trim();
  }

  async evalJson<T = unknown>(script: string): Promise<T> {
    return parseAgentBrowserEvalJson<T>((await this.run(["eval", script])).stdout);
  }

  async fill(selector: string, value: string): Promise<AgentBrowserCommandResult> {
    return this.run(["fill", selector, value]);
  }

  async click(selector: string): Promise<AgentBrowserCommandResult> {
    return this.run(["click", selector]);
  }

  async press(key: string): Promise<AgentBrowserCommandResult> {
    return this.run(["press", key]);
  }

  async wait(ms: number): Promise<AgentBrowserCommandResult> {
    return this.run(["wait", String(ms)]);
  }

  async download(selector: string, targetPath: string): Promise<AgentBrowserCommandResult> {
    return this.run(["download", selector, targetPath]);
  }

  async close(): Promise<AgentBrowserCommandResult> {
    return this.run(["close"]);
  }

  private async run(
    args: string[],
    options: { includeBaseArgs?: boolean } = {},
  ): Promise<AgentBrowserCommandResult> {
    const allArgs = [...(options.includeBaseArgs === false ? [] : this.spec.baseArgs), ...args];
    try {
      const result = await execFileAsync(this.spec.command, allArgs, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      throw toAgentBrowserCommandError(error, this.spec.sensitiveValues);
    }
  }
}

export function parseAgentBrowserEvalJson<T = unknown>(stdout: string): T {
  const content = extractContentBoundary(stdout).trim();
  const parsed = JSON.parse(content) as unknown;
  return (typeof parsed === "string" && /^[[{]/.test(parsed) ? JSON.parse(parsed) : parsed) as T;
}

function extractContentBoundary(stdout: string): string {
  const match =
    /--- AGENT_BROWSER_PAGE_CONTENT[^\n]*---\n([\s\S]*?)\n--- END_AGENT_BROWSER_PAGE_CONTENT/.exec(
      stdout,
    );
  return match?.[1] ?? stdout;
}

export function parseAgentBrowserSnapshot(stdout: string): AgentBrowserSnapshot {
  const parsed = JSON.parse(stdout) as AgentBrowserJsonEnvelope;
  if (parsed.success === false || !parsed.data) {
    throw new AgentBrowserCommandError({
      message: `agent-browser snapshot failed: ${formatUnknownError(parsed.error)}`,
      stdout,
      stderr: "",
      exitCode: null,
    });
  }
  return parsed.data;
}

function toAgentBrowserCommandError(
  error: unknown,
  sensitiveValues: string[],
): AgentBrowserCommandError {
  const stdout = sanitizeText(getStringProperty(error, "stdout"), sensitiveValues);
  const stderr = sanitizeText(getStringProperty(error, "stderr"), sensitiveValues);
  const message = sanitizeText(
    error instanceof Error
      ? [error.message, stdout, stderr].filter(Boolean).join("\n")
      : String(error),
    sensitiveValues,
  );
  return new AgentBrowserCommandError({
    message,
    stdout,
    stderr,
    exitCode: getNumberProperty(error, "code"),
  });
}

function sanitizeText(text: string, sensitiveValues: string[]): string {
  return sensitiveValues.reduce(
    (message, secret) => message.split(secret).join("[redacted]"),
    text,
  );
}

function formatUnknownError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getStringProperty(error: unknown, key: "stdout" | "stderr"): string {
  const value = (error as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

function getNumberProperty(error: unknown, key: "code"): number | null {
  const value = (error as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" ? value : null;
}
