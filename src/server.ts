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

type SessionSseMessage = {
  event: string;
  data: unknown;
};

type SessionSubscriber = (message: SessionSseMessage) => Promise<void>;

class SessionEventHub {
  #subscribers = new Map<string, Set<SessionSubscriber>>();

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    const subscribers = this.#subscribers.get(sessionId) ?? new Set<SessionSubscriber>();
    subscribers.add(subscriber);
    this.#subscribers.set(sessionId, subscribers);

    return () => {
      subscribers.delete(subscriber);

      if (subscribers.size === 0) {
        this.#subscribers.delete(sessionId);
      }
    };
  }

  publish(sessionId: string, event: string, data: unknown): void {
    const subscribers = this.#subscribers.get(sessionId);

    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers) {
      void subscriber({ event, data });
    }
  }
}

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
  const sessionEvents = new SessionEventHub();
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

    return streamSSE(c, async (stream) => {
      const writeMessage = async ({ event, data }: SessionSseMessage) => {
        if (stream.closed || stream.aborted) {
          return;
        }

        await stream.writeSSE({
          event,
          data: JSON.stringify(data),
        });
      };
      let pendingWrite = Promise.resolve();
      const enqueueMessage = (message: SessionSseMessage) => {
        pendingWrite = pendingWrite.then(() => writeMessage(message)).catch(() => undefined);
        return pendingWrite;
      };
      const unsubscribe = sessionEvents.subscribe(sessionId, enqueueMessage);
      const heartbeat = setInterval(() => {
        void enqueueMessage({ event: "heartbeat", data: { ok: true } });
      }, 15_000);

      stream.onAbort(() => {
        unsubscribe();
        clearInterval(heartbeat);
      });

      await enqueueMessage({
        event: "session-snapshot",
        data: getSessionSnapshot(sessionId),
      });

      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
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

    sessionEvents.publish(sessionId, "session-updated", { session });

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

    sessionEvents.publish(sessionId, "session-deleted", { sessionId });
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

    writeRunEvent(run.id, "run-start", {
      runId: run.id,
      sessionId,
      model,
      run,
    });
    sessionEvents.publish(sessionId, "session-updated", {
      session: sessionStore.getSession(sessionId),
    });
    void runAgent({ agent, prompt, runId: run.id, sessionId });

    return c.body(null, 204);
  }

  function getSessionSnapshot(sessionId: string) {
    return {
      session: sessionStore.getSession(sessionId),
      runs: sessionStore.listRuns(sessionId),
      messages: sessionStore.listMessages(sessionId),
    };
  }

  function writeRunEvent(runId: string, event: string, data: unknown): void {
    const serialized = JSON.stringify(data);
    sessionStore.appendRunEvent(runId, event, serialized);
    const run = sessionStore.getRun(runId);

    if (run) {
      sessionEvents.publish(run.sessionId, event, data);
    }
  }

  async function runAgent({
    agent,
    prompt,
    runId,
    sessionId,
  }: {
    agent: ServerAgent;
    prompt: string;
    runId: string;
    sessionId: string;
  }) {
    try {
      const output = await agent.stream(prompt, {
        memory: {
          resource: HARLAN_RESOURCE_ID,
          thread: sessionId,
        },
      });

      for await (const chunk of output.fullStream) {
        const eventData = {
          runId,
          sessionId,
          type: chunk.type,
          payload: (chunk as { payload?: unknown }).payload,
          chunk,
        };

        if (chunk.type === "text-delta") {
          const text = (chunk as { payload?: { text?: unknown } }).payload?.text;

          if (typeof text === "string") {
            sessionStore.appendRunAnswer(runId, text);
          }
        }

        writeRunEvent(runId, chunk.type, eventData);
      }

      if (output.error) {
        throw output.error;
      }

      sessionStore.completeRun(runId);
      const run = sessionStore.getRun(runId);
      writeRunEvent(runId, "done", { ok: true, runId, sessionId, run });
      sessionEvents.publish(sessionId, "session-updated", {
        session: sessionStore.getSession(sessionId),
      });
    } catch (error) {
      const message = toErrorMessage(error);
      sessionStore.failRun(runId, message);
      const run = sessionStore.getRun(runId);
      writeRunEvent(runId, "error", { error: message, runId, sessionId, run });
      sessionEvents.publish(sessionId, "session-updated", {
        session: sessionStore.getSession(sessionId),
      });
    }
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
