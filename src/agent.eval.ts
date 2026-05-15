import "dotenv/config";
import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentChunkType } from "@mastra/core/stream";
import { test } from "vitest";
import { assertProviderConfig, createHarlanAgent, defaultModel } from "./agent.ts";

type AgentEvalCase = {
  name: string;
  prompt: string;
  requiredFacts: string[];
};

type EvalAttemptLog = {
  eval: string;
  attempt: number;
  passed: boolean;
  model: string;
  prompt: string;
  output: string;
  error?: string;
  createdAt: string;
};

const model = defaultModel;
const logPath = ".harlan/evals/live-agent.jsonl";
const maxAttempts = 2;
const testTimeoutMs = 120_000;

const evalCases: AgentEvalCase[] = [
  {
    name: "Find test command",
    prompt:
      "Inspect this repo and tell me which npm command runs the deterministic test suite, plus the underlying test runner command. Keep the answer concise.",
    requiredFacts: ["npm test", "vitest run"],
  },
  {
    name: "Find default model",
    prompt:
      "Inspect this repo and tell me the default model id used by the Harlan agent, and whether an environment variable can override it. Keep the answer concise.",
    requiredFacts: ["openrouter/google/gemini-2.0-flash-lite-001", "HARLAN_MODEL"],
  },
  {
    name: "Find built-in modules",
    prompt:
      "Inspect this repo and list the built-in Harlan modules documented for users. Keep the answer concise.",
    requiredFacts: ["fs", "text", "format", "shell"],
  },
];

async function runAgentText(prompt: string, modelId: string): Promise<string> {
  const agent = createHarlanAgent(modelId);
  const stream = await agent.stream(prompt);
  let output = "";

  for await (const chunk of stream.fullStream as AsyncIterable<AgentChunkType>) {
    if (chunk.type === "text-delta") {
      output += chunk.payload.text;
    }
  }

  if (stream.error) {
    throw stream.error;
  }

  return output;
}

function assertRequiredFacts(output: string, requiredFacts: string[]): void {
  const normalizedOutput = output.toLowerCase();

  for (const fact of requiredFacts) {
    assert.ok(
      normalizedOutput.includes(fact.toLowerCase()),
      `Expected output to include required fact: ${fact}\n\nOutput:\n${output}`,
    );
  }
}

async function appendEvalLog(entry: EvalAttemptLog): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runEvalCase(evalCase: AgentEvalCase): Promise<void> {
  assertProviderConfig(model);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let output = "";

    try {
      output = await runAgentText(evalCase.prompt, model);
      assertRequiredFacts(output, evalCase.requiredFacts);
      await appendEvalLog({
        eval: evalCase.name,
        attempt,
        passed: true,
        model,
        prompt: evalCase.prompt,
        output,
        createdAt: new Date().toISOString(),
      });
      return;
    } catch (error) {
      lastError = error;
      await appendEvalLog({
        eval: evalCase.name,
        attempt,
        passed: false,
        model,
        prompt: evalCase.prompt,
        output,
        error: formatUnknownError(error),
        createdAt: new Date().toISOString(),
      });
    }
  }

  throw lastError;
}

for (const evalCase of evalCases) {
  test.sequential(
    evalCase.name,
    async () => {
      await runEvalCase(evalCase);
    },
    testTimeoutMs,
  );
}
