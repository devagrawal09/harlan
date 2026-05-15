import { Agent } from "@mastra/core/agent";
import type { MastraMemory } from "@mastra/core/memory";
import { createTool } from "@mastra/core/tools";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { join } from "node:path";
import z from "zod";
import { formatUnknownError, renderHarlanResult, runHarlan } from "./harlan/index.ts";
import { resolveStateDir } from "./session-store.ts";

export const defaultModel =
  process.env.HARLAN_MODEL ?? "openrouter/google/gemini-2.0-flash-lite-001";

export const execute_harlan = createTool({
  id: `execute_harlan`,
  description: `Parse and execute Harlan code for deterministic tool workflows.`,
  inputSchema: z.object({ code: z.string() }),
  execute: async ({ code }) => {
    try {
      const result = await runHarlan(code, {
        cwd: process.cwd(),
        env: process.env,
        allowShell: true,
        maxOutputChars: 20_000,
      });
      return renderHarlanResult(result, { maxChars: 20_000 });
    } catch (error) {
      return formatUnknownError(error);
    }
  },
});

export type HarlanAgentOptions = {
  memory?: MastraMemory;
};

export function createHarlanMemory(stateDir = resolveStateDir()): Memory {
  return new Memory({
    storage: new LibSQLStore({
      id: "harlan-memory",
      url: `file:${join(stateDir, "mastra.db")}`,
    }),
    options: {
      lastMessages: 20,
    },
  });
}

export function createHarlanAgent(model: string, options: HarlanAgentOptions = {}): Agent {
  return new Agent({
    id: "harlan-agent",
    name: "Harlan Agent",
    description:
      "An agent that accomplishes tasks by writing code in a REPL that calls tools programmatically.",
    instructions: [
      "You are a pragmatic AI assistant with access to the Harlan REPL, a way to write and execute code in a custom language called Harlan made for you.",
      `Write Harlan code when you need to read files, list or search a codebase, extract structured results, compose tool calls, or produce repeatable workflows.

Prefer fs.glob and fs.search for codebase inspection before shell.run. Use shell.run only when actual shell behavior is needed. Keep scripts small and return the final useful value. Import modules explicitly with let module = import("module"). Use if for existence checks or bounded-result handling. Use destructuring to unpack records returned by stdlib helpers. Use boolean operators instead of nesting conditionals when checking simple predicates.

Example: read README
let fs = import("fs")
let text = import("text")

fs.read("README.md")
  |> text.lines()
  |> text.take(5)

Example: search code
let fs = import("fs")
let format = import("format")

fs.search("src", "execute_harlan").matches
  |> format.table()

Example: search code with bounded-result handling
let fs = import("fs")
let format = import("format")

let { matches, truncated } = fs.search("src", "execute_harlan")

if truncated then
  "too many results"
else
  format.table(matches)

Example: list TypeScript files
let fs = import("fs")
let format = import("format")

fs.glob("src/**/*.ts")
  |> format.lines()`,
    ],
    model,
    memory: options.memory,
    tools: { execute_harlan },
  });
}

export function assertProviderConfig(model: string, env: NodeJS.ProcessEnv = process.env): void {
  const provider = model.split("/", 1)[0];

  if (provider === "openai" && !env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for OpenAI models.");
  }

  if (provider === "openrouter" && !env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter models.");
  }
}
