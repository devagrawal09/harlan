#!/usr/bin/env node

import "dotenv/config";
import { Agent } from "@mastra/core/agent";
import type { AgentChunkType } from "@mastra/core/stream";
import { createTool } from "@mastra/core/tools";
import z from "zod";
import { formatUnknownError, renderHarlanValue, runHarlan } from "./harlan/index.ts";

type CommandContext = {
  args: string[];
};

type CliOptions = {
  model: string;
  promptParts: string[];
};

const defaultModel = process.env.HARLAN_MODEL ?? "openrouter/google/gemini-2.0-flash-lite-001";

function printHelp(): void {
  console.log(`harlan

Usage:
  harlan [options] <task...>
  echo "<task>" | harlan [options]

Options:
  -h, --help           Show this help message
  -v, --version        Show package version
  -m, --model <model>  Model to use (default: $HARLAN_MODEL or ${defaultModel})`);
}

function parseArgs(args: string[]): CliOptions {
  const promptParts: string[] = [];
  let model = defaultModel;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-m" || arg === "--model") {
      const value = args[index + 1];

      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }

      model = value;
      index += 1;
      continue;
    }

    promptParts.push(arg);
  }

  return { model, promptParts };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

const execute_harlan = createTool({
  id: `execute_harlan`,
  description: `Parse and execute Harlan code for deterministic tool workflows.`,
  inputSchema: z.object({ code: z.string() }),
  execute: async ({ code }) => {
    try {
      const result = await runHarlan(code, {
        cwd: process.cwd(),
        env: process.env,
        allowShell: true,
      });
      const output = result.output.length > 0 ? `${result.output.join("\n")}\n` : "";
      return `${output}${renderHarlanValue(result.value)}`;
    } catch (error) {
      return formatUnknownError(error);
    }
  },
});

function createAgent(model: string): Agent {
  return new Agent({
    id: "harlan-agent",
    name: "Harlan Agent",
    description:
      "An agent that accomplishes tasks by writing code in a REPL that calls tools programmatically.",
    instructions: [
      "You are a pragmatic AI assistant with access to the Harlan REPL, a way to write and execute code in a custom language called Harlan made for you.",
      `Write Harlan code when you need to inspect files, compose tool calls, or produce repeatable workflows.

Example:
let fs = import("fs")
let text = import("text")

fs.read("README.md")
  |> text.lines()
  |> text.take(5)`,
    ],
    model,
    tools: { execute_harlan },
  });
}

function assertProviderConfig(model: string): void {
  const provider = model.split("/", 1)[0];

  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for OpenAI models.");
  }

  if (provider === "openrouter" && !process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter models.");
  }
}

async function streamAgentOutput(agent: Agent, prompt: string): Promise<void> {
  const stream = await agent.stream(prompt);

  for await (const chunk of stream.fullStream as AsyncIterable<AgentChunkType>) {
    if (chunk.type === "text-delta") {
      process.stdout.write(chunk.payload.text);
    }
  }

  if (stream.error) {
    throw stream.error;
  }

  process.stdout.write("\n");
}

async function main({ args }: CommandContext): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  if (args.includes("-v") || args.includes("--version")) {
    const packageJson = await import("../package.json", { with: { type: "json" } });
    console.log(packageJson.default.version);
    return;
  }

  const { model, promptParts } = parseArgs(args);
  const prompt = promptParts.join(" ").trim() || (await readStdin());

  if (!prompt) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  assertProviderConfig(model);
  await streamAgentOutput(createAgent(model), prompt);
}

main({ args: process.argv.slice(2) }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
