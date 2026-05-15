import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentChunkType } from "@mastra/core/stream";
import { onTestFinished, test } from "vitest";
import { createServer, type ServerAgent } from "./server.ts";
import { SseEventParser, parseSseEvent, type SseEvent } from "../web/src/events.ts";

type AgentMemoryCall = {
  thread: string;
  resource: string;
};

type AgentStreamOptions = {
  memory?: AgentMemoryCall;
};

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
  assert.equal(((await renamed.json()) as { session: { title: string } }).session.title, "Renamed session");

  const detail = await app.request(`/api/sessions/${createdBody.session.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.headers.get("content-type") ?? "", /text\/event-stream/);
  const detailEvents = await readEventsUntil(detail, "session-snapshot");
  const detailBody = JSON.parse(detailEvents[0]?.data ?? "{}") as {
    session: { id: string; title: string };
    runs: unknown[];
    messages: unknown[];
  };
  assert.equal(detailBody.session.id, createdBody.session.id);
  assert.equal(detailBody.session.title, "Renamed session");
  assert.deepEqual(detailBody.runs, []);
  assert.deepEqual(detailBody.messages, []);

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

  assert.deepEqual(body.sessions.map(({ id, title }) => ({ id, title })), [
    {
      id: session.id,
      title: "Persistent session",
    },
  ]);
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

  const events = await readEventsUntil(response, "session-snapshot");
  assert.deepEqual(
    events.map((event) => event.event),
    ["session-snapshot"],
  );

  const snapshot = JSON.parse(events[0]?.data ?? "{}") as {
    session: { id: string; title: string };
    runs: unknown[];
    messages: unknown[];
  };
  assert.equal(snapshot.session.id, session.id);
  assert.equal(snapshot.session.title, "Stream session");
  assert.deepEqual(snapshot.runs, []);
  assert.deepEqual(snapshot.messages, []);
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
  const prompts: string[] = [];
  const memoryCalls: Array<AgentMemoryCall | undefined> = [];
  const models: string[] = [];
  const fakeAgent: ServerAgent = {
    async stream(prompt: string, options?: AgentStreamOptions) {
      prompts.push(prompt);
      memoryCalls.push(options?.memory);

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

  const events = await readEventsUntil(stream, "done");
  assert.deepEqual(
    events.map((event) => event.event),
    ["session-snapshot", "run-start", "session-updated", "text-delta", "done"],
  );

  const runStart = JSON.parse(events[1]?.data ?? "{}") as {
    runId: string;
    sessionId: string;
    model: string;
    run: {
      id: string;
      prompt: string;
      status: string;
    };
  };
  assert.match(runStart.runId, /^[a-zA-Z0-9_-]+$/);
  assert.equal(runStart.sessionId, sessionId);
  assert.equal(runStart.model, "openrouter/google/gemini-2.0-flash-lite-001");
  assert.equal(runStart.run.id, runStart.runId);
  assert.equal(runStart.run.prompt, "Say hello");
  assert.equal(runStart.run.status, "running");
  assert.equal(JSON.parse(events[3]?.data ?? "{}").payload.text, "hello");
  assert.deepEqual(prompts, ["Say hello"]);
  assert.deepEqual(models, ["openrouter/google/gemini-2.0-flash-lite-001"]);
  assert.deepEqual(memoryCalls, [
    {
      resource: "harlan-workspace",
      thread: sessionId,
    },
  ]);

  const detail = await app.request(`/api/sessions/${sessionId}`);
  const detailEvents = await readEventsUntil(detail, "session-snapshot");
  const detailBody = JSON.parse(detailEvents[0]?.data ?? "{}") as {
    runs: Array<{
      id: string;
      prompt: string;
      model: string;
      status: string;
      answer: string;
      events: Array<{ event: string; data: string; createdAt: string }>;
    }>;
  };
  assert.equal(detailBody.runs.length, 1);
  assert.equal(detailBody.runs[0]?.id, runStart.runId);
  assert.equal(detailBody.runs[0]?.prompt, "Say hello");
  assert.equal(detailBody.runs[0]?.model, "openrouter/google/gemini-2.0-flash-lite-001");
  assert.equal(detailBody.runs[0]?.status, "done");
  assert.equal(detailBody.runs[0]?.answer, "hello");
  assert.deepEqual(
    detailBody.runs[0]?.events.map((event) => event.event),
    ["run-start", "text-delta", "done"],
  );
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

  const events = await readEventsUntil(stream, "session-updated");
  assert.deepEqual(
    events.map((event) => event.event),
    ["session-snapshot", "session-updated"],
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

  const events = await readEventsUntil(stream, "error");
  assert.deepEqual(
    events.map((event) => event.event),
    ["session-snapshot", "run-start", "session-updated", "error"],
  );
  assert.equal(JSON.parse(events[3]?.data ?? "{}").error, "agent failed");

  const detail = await app.request(`/api/sessions/${sessionId}`);
  const detailEvents = await readEventsUntil(detail, "session-snapshot");
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
  const prompts: string[] = [];
  const models: string[] = [];
  const fakeAgent: ServerAgent = {
    async stream(prompt) {
      prompts.push(prompt);

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
    assert.deepEqual(prompts, ["Say hello"]);
    assert.deepEqual(models, ["openrouter/google/gemini-2.0-flash-lite-001"]);
  });
});
