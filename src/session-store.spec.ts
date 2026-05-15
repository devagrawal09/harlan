import { mkdtemp, rm } from "node:fs/promises";
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
    firstStore.appendRunEvent(run.id, "text-delta", JSON.stringify({ payload: { text: "summary" } }));
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
});
