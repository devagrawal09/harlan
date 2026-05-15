#!/usr/bin/env node

import "dotenv/config";
import { serve } from "@hono/node-server";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import type { AgentChunkType } from "@mastra/core/stream";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import z from "zod";
import {
  domainEventNames,
  type DomainEventName,
  type DomainEventPayloadMap,
  type EventLogItem,
} from "../events.ts";
import { assertProviderConfig, createHarlanAgent, defaultModel } from "./agent.ts";
import { SessionStore, type RunRecord, type SessionMessage } from "./session-store.ts";

type AgentStream = {
  fullStream: AsyncIterable<AgentChunkType>;
  error?: unknown;
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
  stream(messages: MessageListInput, options?: unknown): Promise<AgentStream>;
};

export type ServerOptions = {
  createAgent?: (model: string) => ServerAgent;
  env?: NodeJS.ProcessEnv;
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

type SessionSnapshotPayload = {
  session: ReturnType<SessionStore["getSession"]>;
  runs: RunRecord[];
  messages: ReturnType<SessionStore["listMessages"]>;
  events: EventLogItem[];
};

type ExecuteHarlanPayload = {
  toolName?: string;
  args?: {
    code?: string;
  };
  input?: {
    code?: string;
  };
  code?: string;
  result?: string;
  output?: string;
  text?: string;
  content?: string;
};

type PersistedAgentEvent = {
  type: string;
  payload?: ExecuteHarlanPayload;
  chunk?: {
    type?: string;
    payload?: ExecuteHarlanPayload;
  };
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCorsOrigin(origin: string): string | undefined {
  return allowedOriginPatterns.some((pattern) => pattern.test(origin)) ? origin : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEventLogItem<Name extends DomainEventName>(
  name: Name,
  data: DomainEventPayloadMap[Name],
  createdAt = nowIso(),
  id: string = randomUUID(),
): EventLogItem<Name> {
  return {
    id,
    name,
    data,
    createdAt,
  };
}

function parsePersistedRunEventData(event: RunRecord["events"][number]): unknown {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function readExecuteHarlanPayload(event: PersistedAgentEvent): ExecuteHarlanPayload | null {
  const payload = event.payload ?? event.chunk?.payload;
  return payload?.toolName === "execute_harlan" ? payload : null;
}

function readExecuteHarlanCode(payload: ExecuteHarlanPayload): string | null {
  return payload.args?.code ?? payload.input?.code ?? payload.code ?? null;
}

function readExecuteHarlanResult(payload: ExecuteHarlanPayload): string | null {
  return payload.result ?? payload.output ?? payload.text ?? payload.content ?? null;
}

function createRunMessages(previousMessages: SessionMessage[], prompt: string): MessageListInput {
  return [
    ...previousMessages.map((message) => ({
      role: message.role,
      content: message.text,
    })),
    {
      role: "user",
      content: prompt,
    },
  ];
}

function projectRunToDomainEvents(run: RunRecord): EventLogItem[] {
  const events: EventLogItem[] = [
    createEventLogItem(
      domainEventNames.userMessaged,
      {
        session_path: run.sessionId,
        user_message: run.prompt,
      },
      run.startedAt,
      `${run.id}:userMessaged`,
    ),
  ];

  run.events.forEach((event, index) => {
    const persisted = parsePersistedRunEventData(event) as PersistedAgentEvent | null;
    const payload = persisted ? readExecuteHarlanPayload(persisted) : null;

    if (!payload) {
      return;
    }

    const code = readExecuteHarlanCode(payload);
    const result = readExecuteHarlanResult(payload);

    if (code) {
      events.push(
        createEventLogItem(
          domainEventNames.agentExecuted,
          {
            session_path: run.sessionId,
            harlan_executed: code,
          },
          event.createdAt,
          `${run.id}:${index}:agentExecuted`,
        ),
      );
    }

    if (result && event.event !== "tool-call" && event.event !== "tool-call-delta") {
      events.push(
        createEventLogItem(
          domainEventNames.executionCompleted,
          {
            session_path: run.sessionId,
            result,
          },
          event.createdAt,
          `${run.id}:${index}:executionCompleted`,
        ),
      );
    }
  });

  if (run.answer) {
    events.push(
      createEventLogItem(
        domainEventNames.agentResponded,
        {
          session_path: run.sessionId,
          agent_response: run.answer,
        },
        run.completedAt ?? run.startedAt,
        `${run.id}:agentResponded`,
      ),
    );
  }

  return events;
}

export function createServer(options: ServerOptions = {}): Hono {
  const sessionStore = options.sessionStore ?? new SessionStore({ stateDir: options.stateDir });
  const createAgent =
    options.createAgent ?? ((model: string) => createHarlanAgent(model) as ServerAgent);
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
        event: "sessionSnapshot",
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

    sessionEvents.publish(sessionId, "sessionUpdated", { session });

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

    sessionEvents.publish(sessionId, "sessionDeleted", { sessionId });
    sessionStore.deleteSession(sessionId);

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
    const previousMessages = sessionStore.listMessages(sessionId);
    const run = sessionStore.createRun(sessionId, prompt, model);
    const userMessaged = createEventLogItem(domainEventNames.userMessaged, {
      session_path: sessionId,
      user_message: prompt,
    });

    persistRunEvent(run.id, "run-start", {
      runId: run.id,
      sessionId,
      model,
      run,
    });
    publishDomainEvent(userMessaged);
    sessionEvents.publish(sessionId, "sessionUpdated", {
      session: sessionStore.getSession(sessionId),
    });
    void runAgent({ agent, previousMessages, prompt, runId: run.id, sessionId });

    return c.body(null, 204);
  }

  function getSessionSnapshot(sessionId: string): SessionSnapshotPayload {
    const session = sessionStore.getSession(sessionId);
    const runs = sessionStore.listRuns(sessionId);
    const events = session
      ? [
          createEventLogItem(
            domainEventNames.sessionStarted,
            {
              session_path: session.id,
            },
            session.createdAt,
            `${session.id}:sessionStarted`,
          ),
          ...runs.flatMap(projectRunToDomainEvents),
        ]
      : [];

    return {
      session,
      runs,
      messages: sessionStore.listMessages(sessionId),
      events,
    };
  }

  function persistRunEvent(runId: string, event: string, data: unknown): void {
    const serialized = JSON.stringify(data);
    sessionStore.appendRunEvent(runId, event, serialized);
  }

  function publishDomainEvent(event: EventLogItem): void {
    sessionEvents.publish(event.data.session_path, event.name, event);
  }

  async function runAgent({
    agent,
    previousMessages,
    prompt,
    runId,
    sessionId,
  }: {
    agent: ServerAgent;
    previousMessages: SessionMessage[];
    prompt: string;
    runId: string;
    sessionId: string;
  }) {
    try {
      const output = await agent.stream(createRunMessages(previousMessages, prompt));
      let agentResponse = "";

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
            agentResponse += text;
          }
        }

        persistRunEvent(runId, chunk.type, eventData);

        const executeHarlanPayload = readExecuteHarlanPayload(eventData as PersistedAgentEvent);

        if (executeHarlanPayload) {
          const code = readExecuteHarlanCode(executeHarlanPayload);
          const result = readExecuteHarlanResult(executeHarlanPayload);

          if (code) {
            publishDomainEvent(
              createEventLogItem(domainEventNames.agentExecuted, {
                session_path: sessionId,
                harlan_executed: code,
              }),
            );
          }

          if (result && chunk.type !== "tool-call" && chunk.type !== "tool-call-delta") {
            publishDomainEvent(
              createEventLogItem(domainEventNames.executionCompleted, {
                session_path: sessionId,
                result,
              }),
            );
          }
        }
      }

      if (output.error) {
        throw output.error;
      }

      sessionStore.completeRun(runId);
      const run = sessionStore.getRun(runId);
      persistRunEvent(runId, "done", { ok: true, runId, sessionId, run });
      publishDomainEvent(
        createEventLogItem(domainEventNames.agentResponded, {
          session_path: sessionId,
          agent_response: run?.answer ?? agentResponse,
        }),
      );
      sessionEvents.publish(sessionId, "runDone", { ok: true, runId, sessionId, run });
      sessionEvents.publish(sessionId, "sessionUpdated", {
        session: sessionStore.getSession(sessionId),
      });
    } catch (error) {
      const message = toErrorMessage(error);
      sessionStore.failRun(runId, message);
      const run = sessionStore.getRun(runId);
      persistRunEvent(runId, "error", { error: message, runId, sessionId, run });
      sessionEvents.publish(sessionId, "runError", { error: message, runId, sessionId, run });
      sessionEvents.publish(sessionId, "sessionUpdated", {
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
