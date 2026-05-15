import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import z from "zod";

export const HARLAN_RESOURCE_ID = "harlan-workspace";

const runStatusSchema = z.enum(["running", "done", "error"]);

const sessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastRunStatus: runStatusSchema.optional(),
});

const runRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  prompt: z.string(),
  model: z.string().min(1),
  status: runStatusSchema,
  answer: z.string(),
  error: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  events: z.array(
    z.object({
      event: z.string().min(1),
      data: z.string(),
      createdAt: z.string().datetime(),
    }),
  ),
});

const persistedStateSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), sessionSummarySchema),
  runs: z.record(z.string(), runRecordSchema),
});

export type RunStatus = z.infer<typeof runStatusSchema>;

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export type SessionDetail = SessionSummary & {
  resourceId: typeof HARLAN_RESOURCE_ID;
};

export type SessionMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type RunRecord = z.infer<typeof runRecordSchema>;

type PersistedState = z.infer<typeof persistedStateSchema>;

export type SessionStoreOptions = {
  stateDir?: string;
};

export function resolveStateDir(stateDir = process.env.HARLAN_STATE_DIR): string {
  return resolve(stateDir ?? join(process.cwd(), ".harlan", "state"));
}

function emptyState(): PersistedState {
  return {
    version: 1,
    sessions: {},
    runs: {},
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function toDetail(session: SessionSummary): SessionDetail {
  return {
    ...session,
    resourceId: HARLAN_RESOURCE_ID,
  };
}

export class SessionStore {
  readonly stateDir: string;
  readonly statePath: string;
  #state: PersistedState;

  constructor(options: SessionStoreOptions = {}) {
    this.stateDir = resolveStateDir(options.stateDir);
    this.statePath = join(this.stateDir, "sessions.json");
    this.#state = this.#load();
  }

  static async initializeStateDir(stateDir: string): Promise<void> {
    mkdirSync(stateDir, { recursive: true });
  }

  #load(): PersistedState {
    mkdirSync(dirname(this.statePath), { recursive: true });

    if (!existsSync(this.statePath)) {
      return emptyState();
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch (error) {
      throw new Error(`Failed to load Harlan state from ${this.statePath}: ${String(error)}`, {
        cause: error,
      });
    }

    const result = persistedStateSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(`Invalid Harlan state in ${this.statePath}: ${z.prettifyError(result.error)}`);
    }

    return result.data;
  }

  #save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.#state, null, 2)}\n`);
    renameSync(tempPath, this.statePath);
  }

  listSessions(): SessionSummary[] {
    return Object.values(this.#state.sessions).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  createSession(title = "Untitled session"): SessionDetail {
    const trimmedTitle = title.trim() || "Untitled session";
    const timestamp = nowIso();
    const session: SessionSummary = {
      id: randomUUID(),
      title: trimmedTitle,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.#state.sessions[session.id] = session;
    this.#save();

    return toDetail(session);
  }

  getSession(sessionId: string): SessionDetail | null {
    const session = this.#state.sessions[sessionId];
    return session ? toDetail(session) : null;
  }

  getRun(runId: string): RunRecord | null {
    return this.#state.runs[runId] ?? null;
  }

  updateSessionTitle(sessionId: string, title: string): SessionDetail | null {
    const session = this.#state.sessions[sessionId];

    if (!session) {
      return null;
    }

    session.title = title.trim();
    session.updatedAt = nowIso();
    this.#save();

    return toDetail(session);
  }

  deleteSession(sessionId: string): boolean {
    if (!this.#state.sessions[sessionId]) {
      return false;
    }

    delete this.#state.sessions[sessionId];

    for (const [runId, run] of Object.entries(this.#state.runs)) {
      if (run.sessionId === sessionId) {
        delete this.#state.runs[runId];
      }
    }

    this.#save();
    return true;
  }

  hasRunningRun(sessionId: string): boolean {
    return Object.values(this.#state.runs).some(
      (run) => run.sessionId === sessionId && run.status === "running",
    );
  }

  listRuns(sessionId: string): RunRecord[] {
    return Object.values(this.#state.runs)
      .filter((run) => run.sessionId === sessionId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  listMessages(sessionId: string): SessionMessage[] {
    return this.listRuns(sessionId).flatMap((run) => {
      const messages: SessionMessage[] = [
        {
          id: `${run.id}-prompt`,
          role: "user",
          text: run.prompt,
          createdAt: run.startedAt,
        },
      ];

      if (run.answer) {
        messages.push({
          id: `${run.id}-answer`,
          role: "assistant",
          text: run.answer,
          createdAt: run.completedAt ?? run.startedAt,
        });
      }

      return messages;
    });
  }

  createRun(sessionId: string, prompt: string, model: string): RunRecord {
    const timestamp = nowIso();
    const run: RunRecord = {
      id: randomUUID(),
      sessionId,
      prompt,
      model,
      status: "running",
      answer: "",
      startedAt: timestamp,
      events: [],
    };

    this.#state.runs[run.id] = run;
    this.#touchSession(sessionId, "running");
    this.#save();

    return run;
  }

  appendRunEvent(runId: string, event: string, data: string): void {
    const run = this.#state.runs[runId];

    if (!run) {
      return;
    }

    run.events.push({
      event,
      data,
      createdAt: nowIso(),
    });
    this.#save();
  }

  appendRunAnswer(runId: string, text: string): void {
    const run = this.#state.runs[runId];

    if (!run) {
      return;
    }

    run.answer += text;
    this.#save();
  }

  completeRun(runId: string): void {
    const run = this.#state.runs[runId];

    if (!run) {
      return;
    }

    run.status = "done";
    run.completedAt = nowIso();
    this.#touchSession(run.sessionId, "done");
    this.#save();
  }

  failRun(runId: string, error: string): void {
    const run = this.#state.runs[runId];

    if (!run) {
      return;
    }

    run.status = "error";
    run.error = error;
    run.completedAt = nowIso();
    this.#touchSession(run.sessionId, "error");
    this.#save();
  }

  #touchSession(sessionId: string, lastRunStatus?: RunStatus): void {
    const session = this.#state.sessions[sessionId];

    if (!session) {
      return;
    }

    session.updatedAt = nowIso();
    session.lastRunStatus = lastRunStatus;
  }
}
