#!/usr/bin/env node

import "dotenv/config";
import { serve } from "@hono/node-server";
import type { AgentChunkType } from "@mastra/core/stream";
import type { Memory } from "@mastra/memory";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { pathToFileURL } from "node:url";
import z from "zod";
import {
  assertProviderConfig,
  createHarlanAgent,
  createHarlanMemory,
  defaultModel,
} from "./agent.ts";
import { HARLAN_RESOURCE_ID, SessionStore } from "./session-store.ts";

type AgentStream = {
  fullStream: AsyncIterable<AgentChunkType>;
  error?: unknown;
};

type AgentStreamOptions = {
  memory?: {
    resource: string;
    thread: string;
  };
};

export type ServerAgent = {
  stream(prompt: string, options?: AgentStreamOptions): Promise<AgentStream>;
};

export type ServerOptions = {
  createAgent?: (model: string) => ServerAgent;
  env?: NodeJS.ProcessEnv;
  memory?: Memory;
  sessionStore?: SessionStore;
  stateDir?: string;
};

const runRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
});

const createSessionSchema = z.object({
  title: z.string().optional(),
});

const renameSessionSchema = z.object({
  title: z.string().trim().min(1),
});

const allowedOriginPatterns = [
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
  /^https:\/\/harlan\.localhost(?::\d+)?$/,
];

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCorsOrigin(origin: string): string | undefined {
  return allowedOriginPatterns.some((pattern) => pattern.test(origin)) ? origin : undefined;
}

export function createServer(options: ServerOptions = {}): Hono {
  const sessionStore = options.sessionStore ?? new SessionStore({ stateDir: options.stateDir });
  const memory =
    options.memory ?? (options.createAgent ? undefined : createHarlanMemory(sessionStore.stateDir));
  const createAgent =
    options.createAgent ?? ((model: string) => createHarlanAgent(model, { memory }) as ServerAgent);
  const env = options.env ?? process.env;
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: resolveCorsOrigin,
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
    }),
  );

  app.get("/api/sessions", (c) => {
    return c.json({ sessions: sessionStore.listSessions() });
  });

  app.post("/api/sessions", async (c) => {
    let body: unknown;

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON." }, 400);
    }

    const parsed = createSessionSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Request body must include an optional title." }, 400);
    }

    return c.json({ session: sessionStore.createSession(parsed.data.title) }, 201);
  });

  app.get("/api/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = sessionStore.getSession(sessionId);

    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }

    return c.json({
      session,
      runs: sessionStore.listRuns(sessionId),
      messages: sessionStore.listMessages(sessionId),
    });
  });

  app.patch("/api/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    let body: unknown;

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON." }, 400);
    }

    const parsed = renameSessionSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Request body must include a non-empty title." }, 400);
    }

    const session = sessionStore.updateSessionTitle(sessionId, parsed.data.title);

    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }

    return c.json({ session });
  });

  app.delete("/api/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!sessionStore.getSession(sessionId)) {
      return c.json({ error: "Session not found." }, 404);
    }

    if (sessionStore.hasRunningRun(sessionId)) {
      return c.json({ error: "Cannot delete a session with a running run." }, 409);
    }

    sessionStore.deleteSession(sessionId);
    await memory?.deleteThread(sessionId);

    return c.json({ ok: true });
  });

  app.post("/api/sessions/:sessionId/runs", async (c) => {
    const sessionId = c.req.param("sessionId");
    return handleRunRequest(c, sessionId);
  });

  app.post("/api/runs", async (c) => {
    return handleRunRequest(c);
  });

  async function handleRunRequest(c: Context, routeSessionId?: string) {
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
    const sessionId = routeSessionId ?? parsed.data.sessionId ?? sessionStore.createSession().id;
    const session = sessionStore.getSession(sessionId);

    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }

    const model = parsed.data.model ?? defaultModel;

    try {
      assertProviderConfig(model, env);
    } catch (error) {
      return c.json({ error: toErrorMessage(error) }, 500);
    }

    const agent = createAgent(model);
    const run = sessionStore.createRun(sessionId, prompt, model);

    return streamSSE(c, async (stream) => {
      async function writeEvent(event: string, data: unknown) {
        const serialized = JSON.stringify(data);
        sessionStore.appendRunEvent(run.id, event, serialized);
        await stream.writeSSE({ event, data: serialized });
      }

      await writeEvent("run-start", {
        runId: run.id,
        sessionId,
        model,
      });

      try {
        const output = await agent.stream(prompt, {
          memory: {
            resource: HARLAN_RESOURCE_ID,
            thread: sessionId,
          },
        });

        for await (const chunk of output.fullStream) {
          if (chunk.type === "text-delta") {
            const text = (chunk as { payload?: { text?: unknown } }).payload?.text;

            if (typeof text === "string") {
              sessionStore.appendRunAnswer(run.id, text);
            }
          }

          await writeEvent(chunk.type, chunk);
        }

        if (output.error) {
          throw output.error;
        }

        sessionStore.completeRun(run.id);
        await writeEvent("done", { ok: true, runId: run.id, sessionId });
      } catch (error) {
        const message = toErrorMessage(error);
        sessionStore.failRun(run.id, message);
        await writeEvent("error", { error: message, runId: run.id, sessionId });
      }
    });
  }

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
