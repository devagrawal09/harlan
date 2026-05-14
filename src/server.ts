#!/usr/bin/env node

import "dotenv/config";
import { serve } from "@hono/node-server";
import type { AgentChunkType } from "@mastra/core/stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { pathToFileURL } from "node:url";
import z from "zod";
import { assertProviderConfig, createHarlanAgent, defaultModel } from "./agent.ts";

type AgentStream = {
  fullStream: AsyncIterable<AgentChunkType>;
  error?: unknown;
};

export type ServerAgent = {
  stream(prompt: string): Promise<AgentStream>;
};

export type ServerOptions = {
  createAgent?: (model: string) => ServerAgent;
  env?: NodeJS.ProcessEnv;
};

const runRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
});

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createServer(options: ServerOptions = {}): Hono {
  const createAgent = options.createAgent ?? createHarlanAgent;
  const env = options.env ?? process.env;
  const app = new Hono();

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
    }),
  );

  app.post("/api/runs", async (c) => {
    let body: unknown;

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON." }, 400);
    }

    const parsed = runRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Request body must include a non-empty prompt." }, 400);
    }

    const { prompt } = parsed.data;
    const model = parsed.data.model ?? defaultModel;

    try {
      assertProviderConfig(model, env);
    } catch (error) {
      return c.json({ error: toErrorMessage(error) }, 500);
    }

    const agent = createAgent(model);

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "run-start",
        data: JSON.stringify({ model }),
      });

      try {
        const output = await agent.stream(prompt);

        for await (const chunk of output.fullStream) {
          await stream.writeSSE({
            event: chunk.type,
            data: JSON.stringify(chunk),
          });
        }

        if (output.error) {
          throw output.error;
        }

        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ ok: true }),
        });
      } catch (error) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: toErrorMessage(error) }),
        });
      }
    });
  });

  return app;
}

export function startServer(): void {
  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOST ?? "0.0.0.0";

  serve(
    {
      fetch: createServer().fetch,
      hostname,
      port,
    },
    (info) => {
      console.log(`harlan server listening on http://${info.address}:${info.port}`);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
