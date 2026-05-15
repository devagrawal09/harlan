import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentChunkType } from "@mastra/core/stream";
import { onTestFinished, test } from "vitest";
import { createServer, type ServerAgent } from "./server.ts";
import { SseEventParser, parseSseEvent } from "../web/src/events.ts";

type AgentMemoryCall = {
  thread: string;
  resource: string;
};

type AgentStreamOptions = {
  memory?: AgentMemoryCall;
};

function collectEvents(text: string) {
  const parser = new SseEventParser();
  return [...parser.push(text), ...parser.flush()];
}

async function createTempStateDir() {
  const stateDir = await mkdtemp(join(tmpdir(), "harlan-state-"));
  onTestFinished(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  return stateDir;
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
  const detailBody = (await detail.json()) as {
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

test("POST /api/sessions/:sessionId/runs streams with session memory and persists run state", async () => {
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

  const response = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "Say hello" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = collectEvents(await response.text());
  assert.deepEqual(
    events.map((event) => event.event),
    ["run-start", "text-delta", "done"],
  );

  const runStart = JSON.parse(events[0]?.data ?? "{}") as {
    runId: string;
    sessionId: string;
    model: string;
  };
  assert.match(runStart.runId, /^[a-zA-Z0-9_-]+$/);
  assert.equal(runStart.sessionId, sessionId);
  assert.equal(runStart.model, "openrouter/google/gemini-2.0-flash-lite-001");
  assert.equal(JSON.parse(events[1]?.data ?? "{}").payload.text, "hello");
  assert.deepEqual(prompts, ["Say hello"]);
  assert.deepEqual(models, ["openrouter/google/gemini-2.0-flash-lite-001"]);
  assert.deepEqual(memoryCalls, [
    {
      resource: "harlan-workspace",
      thread: sessionId,
    },
  ]);

  const detail = await app.request(`/api/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as {
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

test("POST /api/runs streams agent chunks as SSE without live model calls", async () => {
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

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = collectEvents(await response.text());
  assert.deepEqual(
    events.map((event) => event.event),
    ["run-start", "text-delta", "done"],
  );
  assert.equal(JSON.parse(events[1]?.data ?? "{}").payload.text, "hello");
  assert.deepEqual(prompts, ["Say hello"]);
  assert.deepEqual(models, ["openrouter/google/gemini-2.0-flash-lite-001"]);
});
