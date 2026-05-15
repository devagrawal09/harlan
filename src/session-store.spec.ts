import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.ts";

const stateDirs: string[] = [];

async function createTempStateDir() {
  const stateDir = await mkdtemp(join(tmpdir(), "harlan-state-"));
  stateDirs.push(stateDir);
  return stateDir;
}

afterEach(async () => {
  await Promise.all(
    stateDirs.splice(0).map((stateDir) =>
      rm(stateDir, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("SessionStore", () => {
  it("reloads persisted sessions, runs, answers, and events", async () => {
    const stateDir = await createTempStateDir();
    const firstStore = new SessionStore({ stateDir });
    const session = firstStore.createSession("Persistent work");
    const run = firstStore.createRun(session.id, "Summarize the repo", "openrouter/test-model");

    firstStore.appendRunAnswer(run.id, "summary");
    firstStore.appendRunEvent(
      run.id,
      "text-delta",
      JSON.stringify({ payload: { text: "summary" } }),
    );
    firstStore.completeRun(run.id);

    const secondStore = new SessionStore({ stateDir });

    expect(
      secondStore.listSessions().map(({ id, title, lastRunStatus }) => ({
        id,
        title,
        lastRunStatus,
      })),
    ).toEqual([
      {
        id: session.id,
        title: "Persistent work",
        lastRunStatus: "done",
      },
    ]);

    const runs = secondStore.listRuns(session.id);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: run.id,
      answer: "summary",
    });
    expect(runs[0]?.events[0]?.event).toBe("text-delta");
  });

  it("persists Harlan snapshots across reloads", async () => {
    const stateDir = await createTempStateDir();
    const firstStore = new SessionStore({ stateDir });
    const session = firstStore.createSession("Bindings");

    firstStore.updateHarlanSessionSnapshot(session.id, {
      bindings: {
        fs: { kind: "module", name: "fs" },
        answer: { kind: "number", value: 42 },
      },
      importedModules: ["fs"],
    });

    const secondStore = new SessionStore({ stateDir });

    expect(secondStore.getHarlanSessionSnapshot(session.id)).toEqual({
      bindings: {
        fs: { kind: "module", name: "fs" },
        answer: { kind: "number", value: 42 },
      },
      importedModules: ["fs"],
    });
  });

  it("loads old state files without Harlan session snapshots", async () => {
    const stateDir = await createTempStateDir();
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "sessions.json"),
      `${JSON.stringify({
        version: 1,
        sessions: {},
        runs: {},
      })}\n`,
    );

    const store = new SessionStore({ stateDir });

    expect(store.listSessions()).toEqual([]);
  });

  it("deleting a session clears Harlan state", async () => {
    const stateDir = await createTempStateDir();
    const store = new SessionStore({ stateDir });
    const session = store.createSession("Delete me");

    store.updateHarlanSessionSnapshot(session.id, {
      bindings: { fs: { kind: "module", name: "fs" } },
      importedModules: ["fs"],
    });
    store.deleteSession(session.id);

    expect(store.getHarlanSessionSnapshot(session.id)).toEqual({
      bindings: {},
      importedModules: [],
    });
  });

  it("binding summaries expose names and kinds only", async () => {
    const stateDir = await createTempStateDir();
    const store = new SessionStore({ stateDir });
    const session = store.createSession("Summaries");

    store.updateHarlanSessionSnapshot(session.id, {
      bindings: {
        fs: { kind: "module", name: "fs" },
        secret: { kind: "string", value: "do not expose" },
      },
      importedModules: ["fs"],
    });

    expect(store.getHarlanBindingSummaries(session.id)).toEqual([
      { name: "fs", kind: "module" },
      { name: "secret", kind: "string" },
    ]);
  });
});
