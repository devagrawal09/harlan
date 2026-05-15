import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import type { AgentChunkType } from "@mastra/core/stream";
import { onTestFinished, test } from "vitest";
import { createSessionExecuteHarlanTool, defaultModel } from "./agent.ts";
import { createServer, type ServerAgent } from "./server.ts";
import { SessionStore } from "./session-store.ts";
import { SseEventParser, parseSseEvent, type SseEvent } from "../web/src/events.ts";

async function createTempStateDir() {
  const stateDir = await mkdtemp(join(tmpdir(), "harlan-state-"));
  onTestFinished(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  return stateDir;
}

async function readEventsUntil(response: Response, stopEvent: string): Promise<SseEvent[]> {
  assert.ok(response.body);
  const parser = new SseEventParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];

  try {
    for (;;) {
      let timeoutId: NodeJS.Timeout | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Timed out waiting for ${stopEvent}`)),
            1_000,
          );
        }),
      ]).finally(() => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      });

      if (done) {
        events.push(...parser.push(decoder.decode()));
        events.push(...parser.flush());
        break;
      }

      events.push(...parser.push(decoder.decode(value, { stream: true })));

      if (events.some((event) => event.event === stopEvent)) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return events;
}

async function waitForCondition(assertion: () => void): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

test("parses SSE events split across chunks", () => {
  const parser = new SseEventParser();

  assert.deepEqual(parser.push('event: text-delta\ndata: {"a":'), []);
  assert.deepEqual(parser.push("1}\n\n"), [
    {
      event: "text-delta",
      data: '{"a":1}',
    },
  ]);
});

test("parses multiline SSE data and ignores comments", () => {
  assert.deepEqual(parseSseEvent(": heartbeat\nevent: done\ndata: one\ndata: two"), {
    event: "done",
    data: "one\ntwo",
  });
});

test("GET /api/health returns ok", async () => {
  const app = createServer();
  const response = await app.request("/api/health");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("API routes allow expected browser origins with CORS", async () => {
  const app = createServer();

  const response = await app.request("/api/health", {
    headers: {
      Origin: "http://localhost:3167",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3167");

  const preflight = await app.request("/api/runs", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Content-Type/);
});

test("POST /api/runs validates request body", async () => {
  const app = createServer();

  const invalidJson = await app.request("/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);

  const missingPrompt = await app.request("/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "   " }),
  });
  assert.equal(missingPrompt.status, 400);
});

test("session API creates, lists, renames, loads, and deletes sessions", async () => {
  const stateDir = await createTempStateDir();
  const serverOptions = {
    stateDir,
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  };
  const app = createServer(serverOptions);

  const emptyList = await app.request("/api/sessions");
  assert.equal(emptyList.status, 200);
  assert.deepEqual(await emptyList.json(), { sessions: [] });

  const created = await app.request("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Repo work" }),
  });
  assert.equal(created.status, 201);

  const createdBody = (await created.json()) as {
    session: {
      id: string;
      title: string;
      resourceId: string;
      createdAt: string;
      updatedAt: string;
    };
  };
  assert.match(createdBody.session.id, /^[a-zA-Z0-9_-]+$/);
  assert.equal(createdBody.session.title, "Repo work");
  assert.equal(createdBody.session.resourceId, "harlan-workspace");
  assert.ok(Date.parse(createdBody.session.createdAt));
  assert.ok(Date.parse(createdBody.session.updatedAt));

  const listed = await app.request("/api/sessions");
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    sessions: [
      {
        id: createdBody.session.id,
        title: "Repo work",
        createdAt: createdBody.session.createdAt,
        updatedAt: createdBody.session.updatedAt,
      },
    ],
  });

  const renamed = await app.request(`/api/sessions/${createdBody.session.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Renamed session" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal(
    ((await renamed.json()) as { session: { title: string } }).session.title,
    "Renamed session",
  );

  const detail = await app.request(`/api/sessions/${createdBody.session.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.headers.get("content-type") ?? "", /text\/event-stream/);
  const detailEvents = await readEventsUntil(detail, "sessionSnapshot");
  const detailBody = JSON.parse(detailEvents[0]?.data ?? "{}") as {
    session: { id: string; title: string };
    runs: unknown[];
    messages: unknown[];
    events: unknown[];
  };
  assert.equal(detailBody.session.id, createdBody.session.id);
  assert.equal(detailBody.session.title, "Renamed session");
  assert.deepEqual(detailBody.runs, []);
  assert.deepEqual(detailBody.messages, []);
  assert.deepEqual(detailBody.events, [
    {
      id: `${createdBody.session.id}:sessionStarted`,
      name: "sessionStarted",
      data: {
        session_path: createdBody.session.id,
      },
      createdAt: createdBody.session.createdAt,
    },
  ]);

  const deleted = await app.request(`/api/sessions/${createdBody.session.id}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });

  const missing = await app.request(`/api/sessions/${createdBody.session.id}`);
  assert.equal(missing.status, 404);
});

test("sessions persist on disk across server instances", async () => {
  const stateDir = await createTempStateDir();
  const serverOptions = {
    stateDir,
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  };

  const firstApp = createServer(serverOptions);
  const created = await firstApp.request("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Persistent session" }),
  });
  assert.equal(created.status, 201);
  const session = ((await created.json()) as { session: { id: string; title: string } }).session;

  const secondApp = createServer(serverOptions);
  const listed = await secondApp.request("/api/sessions");
  assert.equal(listed.status, 200);
  const body = (await listed.json()) as { sessions: Array<{ id: string; title: string }> };

  assert.deepEqual(
    body.sessions.map(({ id, title }) => ({ id, title })),
    [
      {
        id: session.id,
        title: "Persistent session",
      },
    ],
  );
});

test("GET /api/sessions/:sessionId streams initial snapshot", async () => {
  const stateDir = await createTempStateDir();
  const app = createServer({
    stateDir,
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });

  const created = await app.request("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Stream session" }),
  });
  assert.equal(created.status, 201);
  const session = ((await created.json()) as { session: { id: string; title: string } }).session;

  const response = await app.request(`/api/sessions/${session.id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = await readEventsUntil(response, "sessionSnapshot");
  assert.deepEqual(
    events.map((event) => event.event),
    ["sessionSnapshot"],
  );

  const snapshot = JSON.parse(events[0]?.data ?? "{}") as {
    session: { id: string; title: string; createdAt: string };
    runs: unknown[];
    messages: unknown[];
    events: unknown[];
  };
  assert.equal(snapshot.session.id, session.id);
  assert.equal(snapshot.session.title, "Stream session");
  assert.deepEqual(snapshot.runs, []);
  assert.deepEqual(snapshot.messages, []);
  assert.deepEqual(snapshot.events, [
    {
      id: `${session.id}:sessionStarted`,
      name: "sessionStarted",
      data: {
        session_path: session.id,
      },
      createdAt: snapshot.session.createdAt,
    },
  ]);
});

test("POST /api/sessions/:sessionId/runs returns 204 and publishes run events", async () => {
  const stateDir = await createTempStateDir();
  const chunks = [
    {
      type: "text-delta",
      payload: {
        text: "hello",
      },
    } as AgentChunkType,
  ];
  const messages: MessageListInput[] = [];
  const models: string[] = [];
  const fakeAgent: ServerAgent = {
    async stream(inputMessages: MessageListInput) {
      messages.push(inputMessages);

      return {
        fullStream: (async function* () {
          yield* chunks;
        })(),
      };
    },
  };
  const serverOptions = {
    stateDir,
    createAgent(model: string) {
      models.push(model);
      return fakeAgent;
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  };
  const app = createServer(serverOptions);

  const created = await app.request("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Run session" }),
  });
  assert.equal(created.status, 201);
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const stream = await app.request(`/api/sessions/${sessionId}`);
  assert.equal(stream.status, 200);

  const response = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "Say hello" }),
  });

  assert.equal(response.status, 204);

  const events = await readEventsUntil(stream, "agentResponded");
  assert.deepEqual(
    events.map((event) => event.event),
    ["sessionSnapshot", "userMessaged", "sessionUpdated", "agentResponded"],
  );
  assert.ok(!events.some((event) => event.event === "text-delta"));

  const userMessaged = JSON.parse(events[1]?.data ?? "{}") as {
    name: string;
    data: {
      session_path: string;
      user_message: string;
    };
  };
  assert.equal(userMessaged.name, "userMessaged");
  assert.equal(userMessaged.data.session_path, sessionId);
  assert.equal(userMessaged.data.user_message, "Say hello");

  const agentResponded = JSON.parse(events[3]?.data ?? "{}") as {
    name: string;
    data: {
      session_path: string;
      agent_response: string;
    };
  };
  assert.equal(agentResponded.name, "agentResponded");
  assert.equal(agentResponded.data.session_path, sessionId);
  assert.equal(agentResponded.data.agent_response, "hello");
  assert.deepEqual(messages, [[{ role: "user", content: "Say hello" }]]);
  assert.deepEqual(models, [defaultModel]);

  const detail = await app.request(`/api/sessions/${sessionId}`);
  const detailEvents = await readEventsUntil(detail, "sessionSnapshot");
  const detailBody = JSON.parse(detailEvents[0]?.data ?? "{}") as {
    runs: Array<{
      id: string;
      prompt: string;
      model: string;
      status: string;
      answer: string;
      events: Array<{ event: string; data: string; createdAt: string }>;
    }>;
    events: Array<{ name: string; data: Record<string, string> }>;
  };
  assert.equal(detailBody.runs.length, 1);
  assert.equal(detailBody.runs[0]?.prompt, "Say hello");
  assert.equal(detailBody.runs[0]?.model, "openrouter/google/gemini-2.0-flash-lite-001");
  assert.equal(detailBody.runs[0]?.status, "done");
  assert.equal(detailBody.runs[0]?.answer, "hello");
  assert.deepEqual(
    detailBody.runs[0]?.events.map((event) => event.event),
    ["run-start", "text-delta", "done"],
  );
  assert.deepEqual(
    detailBody.events.map((event) => event.name),
    ["sessionStarted", "userMessaged", "agentResponded"],
  );
  assert.equal(detailBody.events[1]?.data.user_message, "Say hello");
  assert.equal(detailBody.events[2]?.data.agent_response, "hello");

  const followup = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "Continue" }),
  });

  assert.equal(followup.status, 204);
  await waitForCondition(() => {
    assert.deepEqual(messages[1], [
      { role: "user", content: "Say hello" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "Continue" },
    ]);
  });
});

test("POST /api/sessions/:sessionId/runs publishes Harlan execution events", async () => {
  const stateDir = await createTempStateDir();
  const chunks = [
    {
      type: "tool-call",
      payload: {
        toolName: "execute_harlan",
        args: {
          code: "fs.cwd()",
        },
      },
    } as unknown as AgentChunkType,
    {
      type: "tool-result",
      payload: {
        toolName: "execute_harlan",
        result: "/tmp/project",
      },
    } as unknown as AgentChunkType,
    {
      type: "text-delta",
      payload: {
        text: "done",
      },
    } as AgentChunkType,
  ];
  const fakeAgent: ServerAgent = {
    async stream() {
      return {
        fullStream: (async function* () {
          yield* chunks;
        })(),
      };
    },
  };
  const app = createServer({
    stateDir,
    createAgent() {
      return fakeAgent;
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });

  const created = await app.request("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Tool session" }),
  });
  assert.equal(created.status, 201);
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const stream = await app.request(`/api/sessions/${sessionId}`);
  const response = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "Run Harlan" }),
  });
  assert.equal(response.status, 204);

  const events = await readEventsUntil(stream, "agentResponded");
  assert.deepEqual(
    events.map((event) => event.event),
    [
      "sessionSnapshot",
      "userMessaged",
      "sessionUpdated",
      "agentExecuted",
      "executionCompleted",
      "agentResponded",
    ],
  );

  const agentExecuted = JSON.parse(events[3]?.data ?? "{}") as {
    data: {
      harlan_executed: string;
    };
  };
  const executionCompleted = JSON.parse(events[4]?.data ?? "{}") as {
    data: {
      result: string;
    };
  };

  assert.equal(agentExecuted.data.harlan_executed, "fs.cwd()");
  assert.equal(executionCompleted.data.result, "/tmp/project");

  const detail = await app.request(`/api/sessions/${sessionId}`);
  const detailEvents = await readEventsUntil(detail, "sessionSnapshot");
  const snapshot = JSON.parse(detailEvents[0]?.data ?? "{}") as {
    events: Array<{ name: string; data: Record<string, string> }>;
  };

  assert.deepEqual(
    snapshot.events.map((event) => event.name),
    ["sessionStarted", "userMessaged", "agentExecuted", "executionCompleted", "agentResponded"],
  );
  assert.equal(snapshot.events[2]?.data.harlan_executed, "fs.cwd()");
  assert.equal(snapshot.events[3]?.data.result, "/tmp/project");
});

test("tool-result events do not duplicate Harlan executed events", async () => {
  const stateDir = await createTempStateDir();
  const chunks = [
    {
      type: "tool-call",
      payload: {
        toolName: "execute_harlan",
        args: { code: "fs.cwd()" },
      },
    } as unknown as AgentChunkType,
    {
      type: "tool-result",
      payload: {
        toolName: "execute_harlan",
        args: { code: "fs.cwd()" },
        result: "/tmp/project",
      },
    } as unknown as AgentChunkType,
  ];
  const app = createServer({
    stateDir,
    createAgent() {
      return {
        async stream() {
          return {
            fullStream: (async function* () {
              yield* chunks;
            })(),
          };
        },
      };
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });
  const created = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "No duplicate tool events" }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;
  const stream = await app.request(`/api/sessions/${sessionId}`);

  const response = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Run Harlan" }),
  });
  assert.equal(response.status, 204);

  const liveEvents = await readEventsUntil(stream, "executionCompleted");
  assert.equal(
    liveEvents.filter((event) => event.event === "agentExecuted").length,
    1,
  );
  assert.equal(
    liveEvents.filter((event) => event.event === "executionCompleted").length,
    1,
  );

  const detail = await app.request(`/api/sessions/${sessionId}`);
  const detailEvents = await readEventsUntil(detail, "sessionSnapshot");
  const snapshot = JSON.parse(detailEvents[0]?.data ?? "{}") as {
    events: Array<{ name: string }>;
  };
  assert.equal(snapshot.events.filter((event) => event.name === "agentExecuted").length, 1);
  assert.equal(snapshot.events.filter((event) => event.name === "executionCompleted").length, 1);
});

test("completed runs expose recovered Harlan tool failures", async () => {
  const stateDir = await createTempStateDir();
  const app = createServer({
    stateDir,
    createAgent() {
      return {
        async stream() {
          return {
            fullStream: (async function* () {
              yield {
                type: "tool-result",
                payload: {
                  toolName: "execute_harlan",
                  result: "RuntimeError: unknown binding `text`",
                },
              } as unknown as AgentChunkType;
              yield {
                type: "text-delta",
                payload: { text: "Recovered" },
              } as AgentChunkType;
            })(),
          };
        },
      };
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });
  const created = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Recovered failure" }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;
  const stream = await app.request(`/api/sessions/${sessionId}`);

  const response = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Recover from tool error" }),
  });
  assert.equal(response.status, 204);
  await readEventsUntil(stream, "agentResponded");

  const detail = await app.request(`/api/sessions/${sessionId}`);
  const detailEvents = await readEventsUntil(detail, "sessionSnapshot");
  const snapshot = JSON.parse(detailEvents[0]?.data ?? "{}") as {
    runs: Array<{ status: string; answer: string; toolFailureCount: number }>;
  };

  assert.equal(snapshot.runs[0]?.status, "done");
  assert.equal(snapshot.runs[0]?.answer, "Recovered");
  assert.equal(snapshot.runs[0]?.toolFailureCount, 1);
});

test("server execute_harlan persists bindings within a session only", async () => {
  const stateDir = await createTempStateDir();
  const sessionStore = new SessionStore({ stateDir });
  const app = createServer({
    sessionStore,
    createAgent(_model, { sessionId }) {
      return createToolBackedAgent(sessionStore, sessionId);
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });

  const first = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "First" }),
  });
  const second = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Second" }),
  });
  const firstSessionId = ((await first.json()) as { session: { id: string } }).session.id;
  const secondSessionId = ((await second.json()) as { session: { id: string } }).session.id;

  assert.equal(await runPrompt(app, firstSessionId, 'let fs = import("fs")'), 204);
  await waitForCondition(() => {
    assert.deepEqual(sessionStore.getHarlanBindingSummaries(firstSessionId), [
      { name: "fs", kind: "module" },
    ]);
  });
  assert.equal(await runPrompt(app, firstSessionId, "fs.cwd()"), 204);

  assert.equal(await runPrompt(app, secondSessionId, "fs.cwd()"), 204);

  await waitForCondition(() => {
    const secondRun = sessionStore.listRuns(secondSessionId)[0];
    assert.equal(
      secondRun?.events.some((event) => event.data.includes("unknown binding `fs`")),
      true,
    );
    assert.deepEqual(sessionStore.getHarlanBindingSummaries(secondSessionId), []);
  });
});

test("POST /api/sessions/:sessionId/runs rejects overlapping runs", async () => {
  const stateDir = await createTempStateDir();
  let releaseRun: () => void = () => undefined;
  const fakeAgent: ServerAgent = {
    async stream() {
      return {
        fullStream: (async function* () {
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
          yield {
            type: "text-delta",
            payload: { text: "done" },
          } as AgentChunkType;
        })(),
      };
    },
  };
  const app = createServer({
    stateDir,
    createAgent() {
      return fakeAgent;
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });
  const created = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Overlap" }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const first = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "First" }),
  });
  assert.equal(first.status, 204);

  const second = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Second" }),
  });
  assert.equal(second.status, 409);

  releaseRun();
  await waitForCondition(() => {
    const runs = new SessionStore({ stateDir }).listRuns(sessionId);
    assert.equal(runs[0]?.status, "done");
  });
});

test("session snapshots and updates expose binding summaries without values", async () => {
  const stateDir = await createTempStateDir();
  const sessionStore = new SessionStore({ stateDir });
  const session = sessionStore.createSession("Bindings");
  sessionStore.updateHarlanSessionSnapshot(session.id, {
    bindings: {
      secret: { kind: "string", value: "hidden" },
      fs: { kind: "module", name: "fs" },
    },
    importedModules: ["fs"],
  });
  const app = createServer({
    sessionStore,
    createAgent() {
      return {
        async stream() {
          return {
            fullStream: (async function* () {
              yield {
                type: "text-delta",
                payload: { text: "done" },
              } as AgentChunkType;
            })(),
          };
        },
      };
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });

  const detail = await app.request(`/api/sessions/${session.id}`);
  const detailEvents = await readEventsUntil(detail, "sessionSnapshot");
  const snapshot = JSON.parse(detailEvents[0]?.data ?? "{}") as {
    harlanBindings: Array<{ name: string; kind: string; value?: string }>;
  };
  assert.deepEqual(snapshot.harlanBindings, [
    { name: "fs", kind: "module" },
    { name: "secret", kind: "string" },
  ]);
  assert.equal(JSON.stringify(snapshot.harlanBindings).includes("hidden"), false);

  const stream = await app.request(`/api/sessions/${session.id}`);
  const response = await app.request(`/api/sessions/${session.id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Update" }),
  });
  assert.equal(response.status, 204);

  const events = await readEventsUntil(stream, "sessionUpdated");
  const updated = JSON.parse(events.at(-1)?.data ?? "{}") as {
    harlanBindings: Array<{ name: string; kind: string; value?: string }>;
  };
  assert.deepEqual(updated.harlanBindings, [
    { name: "fs", kind: "module" },
    { name: "secret", kind: "string" },
  ]);
  assert.equal(JSON.stringify(updated.harlanBindings).includes("hidden"), false);
});

test("PATCH /api/sessions/:sessionId publishes session-updated", async () => {
  const stateDir = await createTempStateDir();
  const app = createServer({
    stateDir,
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });

  const created = await app.request("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Before rename" }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;
  const stream = await app.request(`/api/sessions/${sessionId}`);

  const renamed = await app.request(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "After rename" }),
  });
  assert.equal(renamed.status, 200);

  const events = await readEventsUntil(stream, "sessionUpdated");
  assert.deepEqual(
    events.map((event) => event.event),
    ["sessionSnapshot", "sessionUpdated"],
  );
  assert.equal(JSON.parse(events[1]?.data ?? "{}").session.title, "After rename");
});

test("agent errors publish error and persist failed run", async () => {
  const stateDir = await createTempStateDir();
  const fakeAgent: ServerAgent = {
    async stream() {
      throw new Error("agent failed");
    },
  };
  const app = createServer({
    stateDir,
    createAgent() {
      return fakeAgent;
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });

  const created = await app.request("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Error session" }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;
  const stream = await app.request(`/api/sessions/${sessionId}`);

  const response = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "Fail" }),
  });
  assert.equal(response.status, 204);

  const events = await readEventsUntil(stream, "runError");
  assert.deepEqual(
    events.map((event) => event.event),
    ["sessionSnapshot", "userMessaged", "sessionUpdated", "runError"],
  );
  assert.equal(JSON.parse(events[3]?.data ?? "{}").error, "agent failed");

  const detail = await app.request(`/api/sessions/${sessionId}`);
  const detailEvents = await readEventsUntil(detail, "sessionSnapshot");
  const snapshot = JSON.parse(detailEvents[0]?.data ?? "{}") as {
    runs: Array<{
      status: string;
      error?: string;
    }>;
  };
  assert.equal(snapshot.runs[0]?.status, "error");
  assert.equal(snapshot.runs[0]?.error, "agent failed");
});

test("POST /api/runs returns 204 and runs agent without live model calls", async () => {
  const chunks = [
    {
      type: "text-delta",
      payload: {
        text: "hello",
      },
    } as AgentChunkType,
  ];
  const messages: MessageListInput[] = [];
  const models: string[] = [];
  const fakeAgent: ServerAgent = {
    async stream(inputMessages) {
      messages.push(inputMessages);

      return {
        fullStream: (async function* () {
          yield* chunks;
        })(),
      };
    },
  };

  const app = createServer({
    createAgent(model) {
      models.push(model);
      return fakeAgent;
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
  });

  const response = await app.request("/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "Say hello" }),
  });

  assert.equal(response.status, 204);
  await waitForCondition(() => {
    assert.deepEqual(messages, [[{ role: "user", content: "Say hello" }]]);
    assert.deepEqual(models, [defaultModel]);
  });
});

function createToolBackedAgent(sessionStore: SessionStore, sessionId: string): ServerAgent {
  return {
    async stream(messages) {
      const lastMessage = Array.isArray(messages) ? messages.at(-1) : null;
      const code = typeof lastMessage?.content === "string" ? lastMessage.content : "";
      const tool = createSessionExecuteHarlanTool({ sessionId, sessionStore });

      return {
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            payload: {
              toolName: "execute_harlan",
              args: { code },
            },
          } as unknown as AgentChunkType;
          const result = await (
            tool.execute as unknown as (input: { code: string }) => Promise<string>
          )({ code });
          yield {
            type: "tool-result",
            payload: {
              toolName: "execute_harlan",
              result,
            },
          } as unknown as AgentChunkType;
          yield {
            type: "text-delta",
            payload: { text: result },
          } as AgentChunkType;
        })(),
      };
    },
  };
}

async function runPrompt(
  app: ReturnType<typeof createServer>,
  sessionId: string,
  prompt: string,
): Promise<number> {
  const response = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  return response.status;
}
