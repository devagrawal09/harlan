import {
  createMemo,
  createSignal,
  createStore,
  isPending,
  refresh,
  untrack,
} from "solid-js";
import { For, Show } from "@solidjs/web";
import {
  domainEventNames,
  isDomainEventName,
  type DomainEventName,
  type EventLogItem,
} from "../../events";
import { SseEventParser, type SseEvent } from "./events";

declare const __HARLAN_API_URL__: string;

type RunStatus = "idle" | "running" | "done" | "error";

type SessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastRunStatus?: Exclude<RunStatus, "idle">;
};

type SessionDetail = SessionSummary & {
  resourceId: string;
};

type SessionProjection = {
  session: SessionDetail | null;
  events: DomainLogItem[];
  streamError: string;
};

type SessionSnapshot = {
  session: SessionDetail | null;
  events: DomainLogItem[];
};

type SessionUpdatedPayload = {
  session: SessionDetail | null;
};

type RunErrorPayload = {
  error?: string;
};

type DomainLogItem = {
  [Name in DomainEventName]: EventLogItem<Name>;
}[DomainEventName];

const apiBaseUrl = (
  import.meta.env.VITE_HARLAN_API_URL ||
  __HARLAN_API_URL__ ||
  "http://localhost:3000"
).replace(/\/$/, "");

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
    events: [],
    streamError: "",
  };
}

function readEventPayload<T>(event: SseEvent): T {
  return JSON.parse(event.data) as T;
}

function eventTitle(name: DomainEventName): string {
  if (name === domainEventNames.sessionStarted) {
    return "Session started";
  }

  if (name === domainEventNames.userMessaged) {
    return "User";
  }

  if (name === domainEventNames.agentExecuted) {
    return "Harlan executed";
  }

  if (name === domainEventNames.executionCompleted) {
    return "Execution completed";
  }

  return "Agent";
}

type SessionSidebarProps = {
  sessions: SessionSummary[];
  loading: boolean;
  selectedSessionId: string;
  addSession: () => void;
  selectSession: (sessionId: string) => void;
};

function SessionSidebar(props: SessionSidebarProps) {
  return (
    <aside class="session-pane" aria-label="Sessions">
      <div class="session-header">
        <h2>Sessions</h2>
        <button
          class="icon-button"
          type="button"
          onClick={props.addSession}
          aria-label="New session"
        >
          +
        </button>
      </div>

      <Show when={!props.loading} fallback={<span class="empty-state">Loading sessions</span>}>
        <ol class="session-list">
          <For each={props.sessions}>
            {(item) => {
              const active = createMemo(() => item.id === props.selectedSessionId);

              return (
                <li class={`session-item ${active() ? "session-item-active" : ""}`}>
                  <button type="button" onClick={() => props.selectSession(item.id)}>
                    <span>{item.title}</span>
                    <time>{new Date(item.updatedAt).toLocaleString()}</time>
                  </button>
                </li>
              );
            }}
          </For>
        </ol>
      </Show>
    </aside>
  );
}

type SessionHeaderProps = {
  session: SessionDetail | null;
  status: RunStatus;
  renameSession: (title: string) => Promise<void>;
  deleteSession: () => Promise<void>;
};

function SessionHeader(props: SessionHeaderProps) {
  const [draftTitle, setDraftTitle] = createSignal(() => props.session?.title ?? "");

  async function renameCurrentSession() {
    const current = props.session;
    const title = draftTitle().trim();

    if (!current || !title || title === current.title) {
      setDraftTitle(current?.title ?? "");
      return;
    }

    await props.renameSession(title);
  }

  return (
    <header class="workspace-header">
      <div class="toolbar">
        <Show
          when={props.session}
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
                onBlur={() => void renameCurrentSession()}
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
        <span class={`status status-${props.status}`}>{props.status}</span>
      </div>

      <div class="session-actions">
        <button type="button" onClick={() => void renameCurrentSession()} disabled={!props.session}>
          Rename
        </button>
        <button
          class="secondary-button"
          type="button"
          onClick={() => void props.deleteSession()}
          disabled={!props.session}
        >
          Delete
        </button>
      </div>
    </header>
  );
}

type EventLogProps = {
  events: DomainLogItem[];
};

function EventLog(props: EventLogProps) {
  return (
    <section class="event-log-panel" aria-label="Event log">
      <Show
        when={props.events.length > 0}
        fallback={<span class="empty-state">No events yet</span>}
      >
        <ol class="event-log">
          <For each={props.events}>{(item) => <EventLogRow item={item} />}</For>
        </ol>
      </Show>
    </section>
  );
}

function EventLogRow(props: { item: DomainLogItem }) {
  const [collapsed, setCollapsed] = createSignal(true);
  const title = createMemo(() => eventTitle(props.item.name));
  const eventClass = createMemo(() => `event-row event-row-${props.item.name}`);
  const collapsible = createMemo(
    () =>
      props.item.name === domainEventNames.agentExecuted ||
      props.item.name === domainEventNames.executionCompleted,
  );
  const toggleLabel = createMemo(() => (collapsed() ? "Expand" : "Collapse"));

  return (
    <li class={eventClass()}>
      <div class="event-row-header">
        <span>{title()}</span>
        <time>{new Date(props.item.createdAt).toLocaleString()}</time>
      </div>
      <EventToggle
        collapsed={collapsed()}
        collapsible={collapsible()}
        toggleLabel={toggleLabel()}
        toggleCollapsed={() => setCollapsed((current) => !current)}
      />
      <EventLogContent collapsed={collapsible() && collapsed()} item={props.item} />
      <EventToggle
        collapsed={collapsed()}
        collapsible={collapsible()}
        toggleLabel={toggleLabel()}
        toggleCollapsed={() => setCollapsed((current) => !current)}
      />
    </li>
  );
}

type EventToggleProps = {
  collapsed: boolean;
  collapsible: boolean;
  toggleLabel: string;
  toggleCollapsed: () => void;
};

function EventToggle(props: EventToggleProps) {
  return (
    <Show when={props.collapsible}>
      <button
        class="event-toggle"
        type="button"
        aria-expanded={props.collapsed ? "false" : "true"}
        onClick={props.toggleCollapsed}
      >
        {props.toggleLabel}
      </button>
    </Show>
  );
}

function EventLogContent(props: { collapsed: boolean; item: DomainLogItem }) {
  const content = createMemo(() => {
    switch (props.item.name) {
      case domainEventNames.sessionStarted:
        return {
          element: "p",
          className: "system-text",
          text: props.item.data.session_path,
        } as const;
      case domainEventNames.userMessaged:
        return {
          element: "p",
          className: "message-text",
          text: props.item.data.user_message,
        } as const;
      case domainEventNames.agentResponded:
        return {
          element: "p",
          className: "message-text",
          text: props.item.data.agent_response,
        } as const;
      case domainEventNames.agentExecuted:
        return {
          element: "pre",
          className: "code-output",
          text: props.item.data.harlan_executed,
        } as const;
      case domainEventNames.executionCompleted:
        return {
          element: "pre",
          className: "result-output",
          text: props.item.data.result,
        } as const;
    }
  });

  return (
    <Show when={content()} keyed>
      {(currentContent) =>
        currentContent.element === "pre" ? (
          <pre
            class={`${currentContent.className} ${
              props.collapsed ? "event-output-collapsed" : ""
            }`}
          >
            {currentContent.text}
          </pre>
        ) : (
          <p class={currentContent.className}>{currentContent.text}</p>
        )
      }
    </Show>
  );
}

type PromptComposerProps = {
  disabled: boolean;
  running: boolean;
  submitRun: (prompt: string) => Promise<void>;
};

function PromptComposer(props: PromptComposerProps) {
  const [prompt, setPrompt] = createSignal("");

  async function submitPrompt(event: SubmitEvent) {
    event.preventDefault();

    const trimmedPrompt = prompt().trim();

    if (!trimmedPrompt || props.disabled) {
      return;
    }

    await props.submitRun(trimmedPrompt);
    setPrompt("");
  }

  return (
    <form class="prompt-form" onSubmit={submitPrompt}>
      <textarea
        value={prompt()}
        onInput={(event) => setPrompt(event.currentTarget.value)}
        placeholder="Ask Harlan to inspect the repo, summarize files, or continue this session."
        rows={8}
      />
      <button type="submit" disabled={!prompt().trim() || props.disabled}>
        {props.running ? "Running" : "Run"}
      </button>
    </form>
  );
}

export default function App() {
  const [selectedSessionOverride, setSelectedSessionId] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [mutationError, setMutationError] = createSignal("");

  const [sessions] = createSignal<SessionSummary[]>(async () => {
    const data = await readJson<{ sessions: SessionSummary[] }>(
      await fetch(`${apiBaseUrl}/api/sessions`),
    );
    return data.sessions.length > 0 ? data.sessions : [await createSessionRequest()];
  });

  const [selectedSessionId] = createSignal(
    () => selectedSessionOverride() || untrack(sessions)[0]?.id || "",
  );
  const selectedSession = createMemo(() =>
    sessions().find((item) => item.id === selectedSessionId()),
  );

  const [detail] = createStore<SessionProjection>(async function* (draft) {
    const sessionId = selectedSessionId();

    if (!sessionId) {
      yield emptySessionProjection();
      return;
    }

    const response = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}`);
    if (!response.ok || !response.body) {
      const text = await response.text();
      const data = text ? (JSON.parse(text) as { error?: string }) : {};
      throw new Error(data.error ?? (text || `Request failed with ${response.status}`));
    }

    yield emptySessionProjection();

    const parser = new SseEventParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const decoded = parser.push(decoder.decode(value, { stream: true }));
      yield applySessionEvents(draft, decoded);
    }

    yield applySessionEvents(draft, parser.push(decoder.decode()));
    yield applySessionEvents(draft, parser.flush());
  }, emptySessionProjection());

  const status = createMemo<RunStatus>(() => {
    if (submitting()) {
      return "running";
    }

    return detail.session?.lastRunStatus ?? selectedSession()?.lastRunStatus ?? "idle";
  });
  const error = createMemo(() => mutationError() || detail.streamError);
  const promptDisabled = createMemo(() => !selectedSession() || status() === "running");
  const running = createMemo(() => status() === "running");

  function applySessionEvents(draft: SessionProjection, parsedEvents: SseEvent[]) {
    for (const parsedEvent of parsedEvents) {
      if (parsedEvent.event === "heartbeat") {
        continue;
      }

      if (parsedEvent.event === "sessionSnapshot") {
        const payload = readEventPayload<SessionSnapshot>(parsedEvent);
        draft.session = payload.session;
        draft.events = payload.events;
        draft.streamError = "";
        continue;
      }

      if (parsedEvent.event === "sessionUpdated") {
        const payload = readEventPayload<SessionUpdatedPayload>(parsedEvent);
        draft.session = payload.session;
        refresh(sessions);
        continue;
      }

      if (parsedEvent.event === "sessionDeleted") {
        draft.session = null;
        draft.events = [];
        draft.streamError = "";
        refresh(sessions);
        continue;
      }

      if (parsedEvent.event === "runError") {
        const payload = readEventPayload<RunErrorPayload>(parsedEvent);
        draft.streamError = payload.error ?? parsedEvent.data;
        setSubmitting(false);
        refresh(sessions);
        continue;
      }

      if (parsedEvent.event === "runDone") {
        setSubmitting(false);
        refresh(sessions);
        continue;
      }

      if (isDomainEventName(parsedEvent.event)) {
        const domainEvent = readEventPayload<DomainLogItem>(parsedEvent);
        draft.events = [...draft.events, domainEvent];

        if (
          domainEvent.name === domainEventNames.userMessaged ||
          domainEvent.name === domainEventNames.agentResponded
        ) {
          refresh(sessions);
        }

        if (domainEvent.name === domainEventNames.agentResponded) {
          setSubmitting(false);
        }
      }
    }
  }

  async function createSession(title?: string) {
    const session = await createSessionRequest(title);

    refresh(sessions);
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

  async function renameSession(title: string) {
    const current = detail.session;

    if (!current) {
      return;
    }

    try {
      await readJson<{ session: SessionDetail }>(
        await fetch(`${apiBaseUrl}/api/sessions/${current.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title }),
        }),
      );
      refresh(sessions);
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function deleteSession() {
    const current = detail.session;

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
      refresh(sessions);
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function submitRun(trimmedPrompt: string) {
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
    } catch (caught) {
      setSubmitting(false);
      setMutationError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <main class="app-shell">
      <SessionSidebar
        sessions={sessions()}
        loading={isPending(sessions)}
        selectedSessionId={selectedSessionId()}
        addSession={() => void addSession()}
        selectSession={(sessionId) => void selectSession(sessionId)}
      />

      <section class="workspace-pane">
        <SessionHeader
          session={detail.session}
          status={status()}
          renameSession={renameSession}
          deleteSession={deleteSession}
        />

        <EventLog events={detail.events} />

        <PromptComposer disabled={promptDisabled()} running={running()} submitRun={submitRun} />

        <Show when={error()}>
          <pre class="error-output">{error()}</pre>
        </Show>
      </section>
    </main>
  );
}
