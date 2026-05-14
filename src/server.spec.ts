import assert from "node:assert/strict";
import test from "node:test";
import type { AgentChunkType } from "@mastra/core/stream";
import { createServer, type ServerAgent } from "./server.ts";
import { SseEventParser, parseSseEvent } from "../web/src/events.ts";

function collectEvents(text: string) {
  const parser = new SseEventParser();
  return [...parser.push(text), ...parser.flush()];
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
