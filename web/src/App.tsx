import { createMemo, createProjection, createSignal, createStore, refresh } from "solid-js";
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

type SessionProjection = {
  session: SessionDetail | null;
  runs: RunRecord[];
  messages: unknown[];
};

type TimelineEvent = SseEvent & {
  id: number;
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
    const parsed = JSON.parse(event.data) as { payload?: { text?: unknown } };
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
      typeof data?.error === "string" ? data.error : text || `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

export default function App() {
  const [selectedSessionOverride, setSelectedSessionId] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [prompt, setPrompt] = createSignal("");
  const [status, setStatus] = createSignal<RunStatus>("idle");
  const [answer, setAnswer] = createSignal("");
  const [events, setEvents] = createSignal<TimelineEvent[]>([]);
  const [error, setError] = createSignal("");
  let nextEventId = 1;

  const [sessions] = createStore<SessionSummary[]>(
    async () => {
      setLoading(true);

      try {
        const data = await readJson<{ sessions: SessionSummary[] }>(
          await fetch(`${apiBaseUrl}/api/sessions`),
        );
        setError("");
        return data.sessions;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return [];
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const [selectedSessionId] = createSignal(
    () => selectedSessionOverride() || sessions[0]?.id || "",
  );

  const detail = createProjection<SessionProjection>(
    async () => {
      const sessionId = selectedSessionId();

      if (!sessionId) {
        return {
          session: null,
          runs: [],
          messages: [],
        };
      }

      try {
        return await readJson<SessionProjection>(
          await fetch(`${apiBaseUrl}/api/sessions/${sessionId}`),
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return {
          session: null,
          runs: [],
          messages: [],
        };
      }
    },
    {
      session: null,
      runs: [],
      messages: [],
    },
  );

  const runs = createProjection<RunRecord[]>(() => detail.runs, []);
  const session = createMemo(() => detail.session);
  const selectedSession = createMemo(() => sessions.find((item) => item.id === selectedSessionId()));
  const [draftTitle, setDraftTitle] = createSignal(() => session()?.title ?? "");

  async function createSession(title?: string) {
    const data = await readJson<{ session: SessionDetail }>(
      await fetch(`${apiBaseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title }),
      }),
    );

    refresh(sessions);
    return data.session;
  }

  async function addSession() {
    setError("");

    try {
      const created = await createSession("Untitled session");
      await selectSession(created.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function selectSession(sessionId: string) {
    if (!sessionId || sessionId === selectedSessionId()) {
      return;
    }

    setSelectedSessionId(sessionId);
    setStatus("idle");
    setAnswer("");
    setEvents([]);
    setError("");
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
      refresh(sessions);
      refresh(detail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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

      const nextSession = sessions.find((item) => item.id !== current.id);
      setSelectedSessionId(nextSession?.id ?? "");
      refresh(sessions);
      refresh(detail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function submitRun(event: SubmitEvent) {
    event.preventDefault();

    const trimmedPrompt = prompt().trim();
    const sessionId = selectedSessionId();

    if (!trimmedPrompt || !sessionId || status() === "running") {
      return;
    }

    setStatus("running");
    setAnswer("");
    setEvents([]);
    setError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      });

      if (!response.ok || !response.body) {
        const message = await response.text();
        throw new Error(message || `Request failed with ${response.status}`);
      }

      const parser = new SseEventParser();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        const parsedEvents = parser.push(decoder.decode(value, { stream: true }));
        handleEvents(parsedEvents);
      }

      handleEvents(parser.push(decoder.decode()));
      handleEvents(parser.flush());

      setStatus((current) => (current === "running" ? "done" : current));
      setPrompt("");
      refresh(detail);
      refresh(sessions);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleEvents(parsedEvents: SseEvent[]) {
    if (parsedEvents.length === 0) {
      return;
    }

    setEvents((current) => [
      ...current,
      ...parsedEvents.map((item) => ({
        ...item,
        id: nextEventId++,
      })),
    ]);

    for (const parsedEvent of parsedEvents) {
      const text = readChunkText(parsedEvent);

      if (text) {
        setAnswer((current) => current + text);
      }

      if (parsedEvent.event === "error") {
        setStatus("error");
        setError(parsedEvent.data);
      }

      if (parsedEvent.event === "done") {
        setStatus("done");
      }
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

        <Show when={!loading()} fallback={<span class="empty-state">Loading sessions</span>}>
          <ol class="session-list">
            <For each={sessions}>
              {(item) => (
                <li class={`session-item ${item.id === selectedSessionId() ? "session-item-active" : ""}`}>
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
          <button class="secondary-button" type="button" onClick={() => void deleteSession()} disabled={!session()}>
            Delete
          </button>
        </div>

        <section class="history-panel" aria-label="Session history">
          <Show when={runs.length > 0 || answer()} fallback={<span class="empty-state">No runs yet</span>}>
            <ol class="run-list">
              <For each={runs}>
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
              <Show when={answer()}>
                <li class="run-card run-card-active">
                  <div class="run-card-header">
                    <span>{status()}</span>
                    <time>Streaming</time>
                  </div>
                  <p class="prompt-text">{prompt()}</p>
                  <pre>{answer()}</pre>
                </li>
              </Show>
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
          <button type="submit" disabled={!prompt().trim() || !selectedSession() || status() === "running"}>
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
