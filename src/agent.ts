import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import z from "zod";
import {
  formatUnknownError,
  getHarlanRunState,
  renderHarlanResult,
  runHarlan,
  type HarlanBindingSummary,
  type HarlanSessionSnapshot,
} from "./harlan/index.ts";
import type { SessionStore } from "./session-store.ts";

export const defaultModel =
  process.env.HARLAN_MODEL ?? "openrouter/google/gemini-2.0-flash-lite-001";

export const execute_harlan = createTool({
  id: `execute_harlan`,
  description:
    "Execute Harlan code for deterministic tool workflows. Harlan uses `and`/`or`/`not`, named `fn name(...) = expression` functions, and only documented stdlib helpers.",
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

export function createSessionExecuteHarlanTool({
  sessionId,
  sessionStore,
  onBindingsChanged,
}: {
  sessionId: string;
  sessionStore: SessionStore;
  onBindingsChanged?: (bindings: HarlanBindingSummary[]) => void;
}) {
  return createTool({
    id: `execute_harlan`,
    description:
      "Execute Harlan code in this persistent session. Top-level let/fn bindings persist across calls. Reuse existing bindings and import each module only once. Harlan uses `and`/`or`/`not`, named `fn name(...) = expression` functions, and only documented stdlib helpers.",
    inputSchema: z.object({ code: z.string() }),
    execute: async ({ code }) => {
      const before = sessionStore.getHarlanBindingSummaries(sessionId);
      let snapshot: HarlanSessionSnapshot | undefined;

      try {
        const result = await runHarlan(code, {
          cwd: process.cwd(),
          env: process.env,
          allowShell: true,
          maxOutputChars: 20_000,
          sessionSnapshot: sessionStore.getHarlanSessionSnapshot(sessionId),
          maxSessionStateChars: 1_000_000,
        });
        snapshot = result.sessionSnapshot;
        return renderHarlanResult(result, { maxChars: 20_000 });
      } catch (error) {
        const runState = getHarlanRunState(error);
        snapshot = runState?.sessionSnapshot;
        const warningPrefix =
          runState && runState.warnings.length > 0 ? `${runState.warnings.join("\n")}\n` : "";
        return `${warningPrefix}${formatUnknownError(error)}`;
      } finally {
        if (snapshot) {
          sessionStore.updateHarlanSessionSnapshot(sessionId, snapshot);
          const after = sessionStore.getHarlanBindingSummaries(sessionId);
          if (JSON.stringify(before) !== JSON.stringify(after)) {
            onBindingsChanged?.(after);
          }
        }
      }
    },
  });
}

export function createHarlanAgent(
  model: string,
  options: { executeHarlanTool?: typeof execute_harlan } = {},
): Agent {
  return new Agent({
    id: "harlan-agent",
    name: "Harlan Agent",
    description:
      "An agent that accomplishes tasks by writing code in a REPL that calls tools programmatically.",
    instructions: [
      "You are a pragmatic AI assistant with access to the Harlan REPL, a way to write and execute code in a custom language called Harlan made for you.",
      `Write Harlan code when you need to read files, list or search a codebase, extract structured results, compose tool calls, or produce repeatable workflows.

Harlan is not JavaScript. Do not use JavaScript syntax such as &&, ||, arrow functions, anonymous block functions, semicolons, or helpers that are not documented. Use Harlan boolean operators: and, or, not. Only named top-level functions are supported: fn name(arg: Type) = expression. Do not write anonymous functions like fn (x) { ... }.

Prefer fs.glob and fs.search for codebase inspection before shell.run. Use shell.run only when actual shell behavior is needed. Keep scripts small and return the final useful value. Before writing imports, assume prior top-level bindings may still exist in this session. Import each module once per session with let module = import("module"), then reuse existing bindings in later scripts. If a duplicate-import warning appears, omit that import next time. Use if for existence checks or bounded-result handling. Use destructuring to unpack records returned by stdlib helpers. Use boolean operators instead of nesting conditionals when checking simple predicates. Do not invent helpers like text.filter.

Available modules and helpers:
- fs: cwd, read, list, exists, glob, search, info
- text: lines, join, take, contains, trim, lower, includes
- format: json, lines, table
- shell: run

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
    tools: { execute_harlan: options.executeHarlanTool ?? execute_harlan },
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
