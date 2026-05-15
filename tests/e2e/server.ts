import { serve } from "@hono/node-server";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import type { AgentChunkType } from "@mastra/core/stream";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type ServerAgent } from "../../src/server.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createE2eAgent(): ServerAgent {
  return {
    async stream(messages: MessageListInput) {
      const lastMessage = messages.at(-1);
      const prompt =
        typeof lastMessage?.content === "string" ? lastMessage.content : "the latest prompt";
      const chunks = [
        {
          type: "tool-call",
          payload: {
            toolName: "execute_harlan",
            args: {
              code: `inspect("${prompt}")`,
            },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolName: "execute_harlan",
            result: `inspected: ${prompt}`,
          },
        },
        {
          type: "text-delta",
          payload: {
            text: `Finished: ${prompt}`,
          },
        },
      ] as AgentChunkType[];

      return {
        fullStream: (async function* () {
          for (const chunk of chunks) {
            await delay(100);
            yield chunk;
          }
        })(),
      };
    },
  };
}

export function startE2eServer(): void {
  const port = Number(process.env.PORT ?? 43117);
  const hostname = process.env.HOST ?? "127.0.0.1";
  const stateDir = mkdtempSync(join(tmpdir(), "harlan-e2e-"));

  const server = serve(
    {
      fetch: createServer({
        createAgent: createE2eAgent,
        env: {
          OPENROUTER_API_KEY: "e2e-test-key",
        },
        stateDir,
      }).fetch,
      hostname,
      port,
    },
    (info) => {
      console.log(`harlan e2e server listening on http://${info.address}:${info.port}`);
    },
  );

  async function shutdown() {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startE2eServer();
}
