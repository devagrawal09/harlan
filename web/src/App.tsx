import {
  createMemo,
  createSignal,
  createStore,
  isPending,
  onCleanup,
  refresh,
} from "solid-js";
import { For, Show } from "@solidjs/web";
import { SseEventParser, type SseEvent } from "./events";

declare const __HARLAN_API_URL__: string;

type RunStatus = "idle" | "running" | "done" | "error";

type SessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastRunStatus?: RunStatus;
};

type RunRecord = {
  id: string;
  sessionId: string;
  prompt: string;
  model: string;
  status: RunStatus;
  answer: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  events: Array<{
    event: string;
    data: string;
    createdAt: string;
  }>;
};

type SessionDetail = SessionSummary & {
  resourceId: string;
};

type TimelineEvent = SseEvent & {
  id: number;
};

type SessionProjection = {
  session: SessionDetail | null;
  runs: RunRecord[];
  messages: unknown[];
  events: TimelineEvent[];
  streamError: string;
};

type SessionsProjection = {
  items: SessionSummary[];
  error: string;
};

type SessionSnapshot = {
  session: SessionDetail | null;
  runs: RunRecord[];
  messages: unknown[];
};

type SessionUpdatedPayload = {
  session: SessionDetail | null;
};

type RunEventPayload = {
  runId: string;
  sessionId: string;
  payload?: {
    text?: unknown;
  };
  run?: RunRecord | null;
  error?: string;
};

const apiBaseUrl = (
  import.meta.env.VITE_HARLAN_API_URL ||
  __HARLAN_API_URL__ ||
  "http://localhost:3000"
).replace(/\/$/, "");

function readChunkText(event: SseEvent): string {
  if (event.event !== "text-delta") {
    return "";
  }

  try {
    const parsed = JSON.parse(event.data) as RunEventPayload;
    return typeof parsed.payload?.text === "string" ? parsed.payload.text : "";
  } catch {
    return "";
  }
}

function eventLabel(event: SseEvent): string {
  if (event.event === "run-start") {
    return "run started";
  }

  if (event.event === "text-delta") {
    return "text";
  }

  return event.event;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message =
      typeof data?.error === "string"
        ? data.error
        : text || `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

async function createSessionRequest(title?: string): Promise<SessionDetail> {
  const data = await readJson<{ session: SessionDetail }>(
    await fetch(`${apiBaseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    }),
  );

  return data.session;
}

function emptySessionProjection(): SessionProjection {
  return {
    session: null,
    runs: [],
    messages: [],
    events: [],
    streamError: "",
  };
}

function replaceSessionProjection(draft: SessionProjection, next: SessionProjection): void {
  draft.session = next.session;
  draft.runs = next.runs;
  draft.messages = next.messages;
  draft.events = next.events;
  draft.streamError = next.streamError;
}

function readEventPayload<T>(event: SseEvent): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

function upsertRun(runs: RunRecord[], run: RunRecord): RunRecord[] {
  const index = runs.findIndex((item) => item.id === run.id);

  if (index === -1) {
    return [...runs, run].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  return runs.map((item) => (item.id === run.id ? run : item));
}

function updateRun(
  runs: RunRecord[],
  runId: string,
  update: (run: RunRecord) => RunRecord,
): RunRecord[] {
  return runs.map((run) => (run.id === runId ? update(run) : run));
}

function persistedTimelineEvents(runs: RunRecord[], nextId: () => number): TimelineEvent[] {
  return runs.flatMap((run) =>
    run.events.map((event) => ({
      id: nextId(),
      event: event.event,
      data: event.data,
    })),
  );
}

export default function App() {
  const [selectedSessionOverride, setSelectedSessionId] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [mutationError, setMutationError] = createSignal("");
  let nextEventId = 1;
  const nextTimelineEventId = () => nextEventId++;

  const [sessionState] = createSignal<SessionsProjection>(async () => {
    try {
      const data = await readJson<{ sessions: SessionSummary[] }>(
        await fetch(`${apiBaseUrl}/api/sessions`),
      );
      const loadedSessions =
        data.sessions.length > 0 ? data.sessions : [await createSessionRequest()];

      return {
        items: loadedSessions,
        error: "",
      };
    } catch (caught) {
      return {
        items: [],
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }
  });

  const sessions = createMemo(() => sessionState().items);
  const sessionsLoading = createMemo(() => isPending(() => sessionState()));
  const [selectedSessionId] = createSignal(
    () => selectedSessionOverride() || sessions()[0]?.id || "",
  );

  const [detail] = createStore<SessionProjection>(
    async (draft) => {
      const sessionId = selectedSessionId();

      if (!sessionId) {
        replaceSessionProjection(draft, emptySessionProjection());
        return;
      }

      const controller = new AbortController();
      onCleanup(() => controller.abort());

      try {
        const response = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}`, {
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const text = await response.text();
          let message = text || `Request failed with ${response.status}`;

          try {
            const data = JSON.parse(text) as { error?: unknown };
            message = typeof data.error === "string" ? data.error : message;
          } catch {
            // Keep the raw response text when the server did not return JSON.
          }

          replaceSessionProjection(draft, {
            ...emptySessionProjection(),
            streamError: message,
          });
          return;
        }

        replaceSessionProjection(draft, emptySessionProjection());

        const parser = new SseEventParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        for (;;) {
          const { value, done } = await reader.read();

          if (done) {
            break;
          }

          applySessionEvents(draft, parser.push(decoder.decode(value, { stream: true })));
        }

        applySessionEvents(draft, parser.push(decoder.decode()));
        applySessionEvents(draft, parser.flush());
      } catch (caught) {
        if (controller.signal.aborted) {
          return;
        }

        replaceSessionProjection(draft, {
          ...emptySessionProjection(),
          streamError: caught instanceof Error ? caught.message : String(caught),
        });
      }
    },
    emptySessionProjection(),
  );

  const runs = createMemo(() => detail.runs);
  const events = createMemo(() => detail.events);
  const session = createMemo(() => detail.session);
  const selectedSession = createMemo(() =>
    sessions().find((item) => item.id === selectedSessionId()),
  );
  const runningRun = createMemo(() => runs().find((run) => run.status === "running"));
  const status = createMemo<RunStatus>(() => {
    if (runningRun() || submitting()) {
      return "running";
    }

    return runs().at(-1)?.status ?? "idle";
  });
  const error = createMemo(() => mutationError() || sessionState().error || detail.streamError);
  const [draftTitle, setDraftTitle] = createSignal(() => session()?.title ?? "");

  function applySessionEvents(draft: SessionProjection, parsedEvents: SseEvent[]) {
    for (const parsedEvent of parsedEvents) {
      if (parsedEvent.event === "heartbeat") {
        continue;
      }

      draft.events = [
        ...draft.events,
        {
          ...parsedEvent,
          id: nextTimelineEventId(),
        },
      ];

      if (
        parsedEvent.event === "run-start" ||
        parsedEvent.event === "done" ||
        parsedEvent.event === "error" ||
        parsedEvent.event === "session-updated"
      ) {
        refresh(sessionState);
      }

      if (parsedEvent.event === "session-snapshot") {
        const payload = readEventPayload<SessionSnapshot>(parsedEvent);

        if (payload) {
          draft.session = payload.session;
          draft.runs = payload.runs;
          draft.messages = payload.messages;
          draft.events = persistedTimelineEvents(payload.runs, nextTimelineEventId);
          draft.streamError = "";
        }
      }

      if (parsedEvent.event === "session-updated") {
        const payload = readEventPayload<SessionUpdatedPayload>(parsedEvent);
        draft.session = payload?.session ?? draft.session;
      }

      if (parsedEvent.event === "session-deleted") {
        replaceSessionProjection(draft, emptySessionProjection());
      }

      if (parsedEvent.event === "run-start") {
        const payload = readEventPayload<RunEventPayload>(parsedEvent);

        if (payload?.run) {
          draft.runs = upsertRun(draft.runs, payload.run);
          setSubmitting(false);
        }
      }

      if (parsedEvent.event === "text-delta") {
        const payload = readEventPayload<RunEventPayload>(parsedEvent);
        const text = readChunkText(parsedEvent);

        if (payload && text) {
          draft.runs = updateRun(draft.runs, payload.runId, (run) => ({
            ...run,
            answer: `${run.answer}${text}`,
          }));
        }
      }

      if (parsedEvent.event === "done" || parsedEvent.event === "error") {
        const payload = readEventPayload<RunEventPayload>(parsedEvent);

        if (payload?.run) {
          draft.runs = upsertRun(draft.runs, payload.run);
        }

        if (parsedEvent.event === "error") {
          draft.streamError = payload?.error ?? parsedEvent.data;
        }

        setSubmitting(false);
      }
    }
  }

  async function createSession(title?: string) {
    const session = await createSessionRequest(title);

    refresh(sessionState);
    return session;
  }

  async function addSession() {
    setMutationError("");

    try {
      const created = await createSession("Untitled session");
      await selectSession(created.id);
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function selectSession(sessionId: string) {
    if (!sessionId || sessionId === selectedSessionId()) {
      return;
    }

    setSelectedSessionId(sessionId);
    setSubmitting(false);
    setMutationError("");
  }

  async function renameSession() {
    const current = session();
    const title = draftTitle().trim();

    if (!current || !title || title === current.title) {
      setDraftTitle(current?.title ?? "");
      return;
    }

    try {
      const data = await readJson<{ session: SessionDetail }>(
        await fetch(`${apiBaseUrl}/api/sessions/${current.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title }),
        }),
      );
      setDraftTitle(data.session.title);
      refresh(sessionState);
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function deleteSession() {
    const current = session();

    if (!current || !confirm(`Delete "${current.title}"?`)) {
      return;
    }

    try {
      await readJson<{ ok: true }>(
        await fetch(`${apiBaseUrl}/api/sessions/${current.id}`, {
          method: "DELETE",
        }),
      );

      const nextSession =
        sessions().find((item) => item.id !== current.id) ??
        (await createSession("Untitled session"));

      setSelectedSessionId(nextSession.id);
      refresh(sessionState);
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function submitRun(event: SubmitEvent) {
    event.preventDefault();

    const trimmedPrompt = prompt().trim();
    const sessionId = selectedSessionId();

    if (!trimmedPrompt || !sessionId || status() === "running") {
      return;
    }

    setSubmitting(true);
    setMutationError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Request failed with ${response.status}`);
      }

      setPrompt("");
      refresh(sessionState);
    } catch (caught) {
      setSubmitting(false);
      setMutationError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <main class="app-shell">
      <aside class="session-pane" aria-label="Sessions">
        <div class="session-header">
          <h2>Sessions</h2>
          <button class="icon-button" type="button" onClick={addSession} aria-label="New session">
            +
          </button>
        </div>

        <Show
          when={!sessionsLoading()}
          fallback={<span class="empty-state">Loading sessions</span>}
        >
          <ol class="session-list">
            <For each={sessions()}>
              {(item) => (
                <li
                  class={`session-item ${item.id === selectedSessionId() ? "session-item-active" : ""}`}
                >
                  <button type="button" onClick={() => void selectSession(item.id)}>
                    <span>{item.title}</span>
                    <time>{new Date(item.updatedAt).toLocaleString()}</time>
                  </button>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </aside>

      <section class="run-pane">
        <div class="toolbar">
          <Show
            when={session()}
            fallback={
              <div>
                <h1>Harlan</h1>
                <p>No session selected</p>
              </div>
            }
          >
            {(current) => (
              <div class="session-title">
                <input
                  value={draftTitle()}
                  onInput={(event) => setDraftTitle(event.currentTarget.value)}
                  onBlur={() => void renameSession()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  aria-label="Session title"
                />
                <p>{current().resourceId}</p>
              </div>
            )}
          </Show>
          <span class={`status status-${status()}`}>{status()}</span>
        </div>

        <div class="session-actions">
          <button type="button" onClick={() => void renameSession()} disabled={!session()}>
            Rename
          </button>
          <button
            class="secondary-button"
            type="button"
            onClick={() => void deleteSession()}
            disabled={!session()}
          >
            Delete
          </button>
        </div>

        <section class="history-panel" aria-label="Session history">
          <Show when={runs().length > 0} fallback={<span class="empty-state">No runs yet</span>}>
            <ol class="run-list">
              <For each={runs()}>
                {(item) => (
                  <li class="run-card">
                    <div class="run-card-header">
                      <span>{item.status}</span>
                      <time>{new Date(item.startedAt).toLocaleString()}</time>
                    </div>
                    <p class="prompt-text">{item.prompt}</p>
                    <Show when={item.error}>
                      <pre class="error-output">{item.error}</pre>
                    </Show>
                    <pre>{item.answer || "No response captured"}</pre>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </section>

        <form class="prompt-form" onSubmit={submitRun}>
          <textarea
            value={prompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
            placeholder="Ask Harlan to inspect the repo, summarize files, or continue this session."
            rows={8}
          />
          <button
            type="submit"
            disabled={!prompt().trim() || !selectedSession() || status() === "running"}
          >
            {status() === "running" ? "Running" : "Run"}
          </button>
        </form>

        <Show when={error()}>
          <pre class="error-output">{error()}</pre>
        </Show>
      </section>

      <aside class="event-pane" aria-label="Stream events">
        <h2>Events</h2>
        <ol>
          <For each={events()}>
            {(item) => (
              <li>
                <span>{eventLabel(item)}</span>
                <code>{item.data}</code>
              </li>
            )}
          </For>
        </ol>
      </aside>
    </main>
  );
}
