import { createMemo, createSignal, createStore, isPending, refresh, untrack } from "solid-js";
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

type HarlanBindingSummary = {
  name: string;
  kind: "null" | "string" | "number" | "boolean" | "list" | "record" | "module" | "function";
};

type SessionProjection = {
  session: SessionDetail | null;
  events: DomainLogItem[];
  harlanBindings: HarlanBindingSummary[];
  streamError: string;
};

type SessionSnapshot = {
  session: SessionDetail | null;
  events: DomainLogItem[];
  harlanBindings: HarlanBindingSummary[];
};

type SessionUpdatedPayload = {
  session: SessionDetail | null;
  harlanBindings?: HarlanBindingSummary[];
};

type RunErrorPayload = {
  error?: string;
};

type DomainLogItem = {
  [Name in DomainEventName]: EventLogItem<Name>;
}[DomainEventName];

const appShellClass =
  "grid min-h-screen grid-cols-1 bg-[#f6f7f4] font-sans text-[#18201f] [font-synthesis:none] [text-rendering:optimizeLegibility] min-[761px]:grid-cols-[260px_minmax(0,1fr)]";
const primaryButtonClass =
  "w-fit min-w-24 cursor-pointer rounded-lg border-0 bg-[#18201f] px-[18px] py-2.5 text-white disabled:cursor-not-allowed disabled:bg-[#dbe0dc] disabled:text-[#66706a]";
const secondaryButtonClass = `${primaryButtonClass} border border-[#cbd2ca] bg-white text-[#22302c]`;
const emptyStateClass = "text-[#7a837d]";
const listClass = "grid list-none gap-2.5 p-0";
const messageTextClass =
  "whitespace-pre-wrap break-words leading-[1.55] text-[#22302c] [overflow-wrap:anywhere]";
const systemTextClass =
  "whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-[#66706a] [overflow-wrap:anywhere]";
const codeOutputClass =
  "m-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[#e0ded6] bg-[#fbfaf6] p-3 font-mono text-[13px] leading-[1.55] text-[#22302c] [overflow-wrap:anywhere]";
const errorOutputClass =
  "m-0 whitespace-pre-wrap break-words rounded-lg border border-[#cbd2ca] bg-white p-3.5 font-mono text-[13px] leading-[1.55] text-[#8c2f2f] [overflow-wrap:anywhere]";

function statusClass(status: RunStatus) {
  const statusColorClass =
    status === "running"
      ? "border-[#2f6f7e] text-[#1c5967]"
      : status === "done"
        ? "border-[#3c7a52] text-[#28613d]"
        : status === "error"
          ? "border-[#a44a4a] text-[#8c2f2f]"
          : "border-[#cbd2ca] text-[#4f5a55]";

  return `min-w-[88px] rounded-full border px-3 py-1.5 text-center capitalize ${statusColorClass}`;
}

function eventRowClass(name: DomainEventName) {
  const baseClass = "grid min-w-0 gap-2.5 rounded-lg border bg-white p-3.5";

  if (name === domainEventNames.sessionStarted) {
    return `${baseClass} bg-[#f7f8f6] px-3 py-2.5`;
  }

  if (name === domainEventNames.userMessaged) {
    return `${baseClass} border-[#c9d8df] bg-[#fbfdfe]`;
  }

  if (name === domainEventNames.agentExecuted || name === domainEventNames.executionCompleted) {
    return `${baseClass} border-[#d7d1c3] bg-[#fffdf8]`;
  }

  return `${baseClass} border-[#cdd9cf]`;
}

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
    harlanBindings: [],
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
    <aside
      class="flex flex-col gap-3.5 border-b border-[#d9ded9] bg-white px-3.5 py-5 min-[761px]:border-r min-[761px]:border-b-0"
      aria-label="Sessions"
    >
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-bold uppercase">Sessions</h2>
        <button
          class={`${primaryButtonClass} inline-grid size-[34px] min-w-[34px] place-items-center p-0 text-xl`}
          type="button"
          onClick={props.addSession}
          aria-label="New session"
        >
          +
        </button>
      </div>

      <Show when={!props.loading} fallback={<span class={emptyStateClass}>Loading sessions</span>}>
        <ol class={listClass}>
          <For each={props.sessions}>
            {(item) => {
              const active = createMemo(() => item.id === props.selectedSessionId);
              const itemButtonClass = createMemo(
                () =>
                  `grid w-full min-w-0 gap-[5px] rounded-lg border p-2.5 text-left text-[#22302c] hover:border-[#cbd2ca] hover:bg-[#eef2ef] ${
                    active() ? "border-[#cbd2ca] bg-[#eef2ef]" : "border-transparent bg-transparent"
                  }`,
              );

              return (
                <li>
                  <button
                    class={itemButtonClass()}
                    type="button"
                    onClick={() => props.selectSession(item.id)}
                  >
                    <span class="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-bold text-[#22302c]">
                      {item.title}
                    </span>
                    <time class="text-xs text-[#66706a]">
                      {new Date(item.updatedAt).toLocaleString()}
                    </time>
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
    <header class="grid gap-3.5">
      <div class="flex flex-col items-start justify-between gap-3 min-[761px]:flex-row min-[761px]:items-center">
        <Show
          when={props.session}
          fallback={
            <div>
              <h1 class="text-2xl font-bold">Harlan</h1>
              <p class="text-[#66706a]">No session selected</p>
            </div>
          }
        >
          {(current) => (
            <div class="grid min-w-0 gap-1">
              <input
                class="w-full min-w-0 max-w-[560px] border-0 bg-transparent p-0 text-2xl font-bold text-[#18201f] focus:outline-3 focus:outline-[#cce7ed]"
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
              <p class="text-[#66706a]">{current().resourceId}</p>
            </div>
          )}
        </Show>
        <span class={statusClass(props.status)}>{props.status}</span>
      </div>

      <div class="flex flex-wrap gap-2.5">
        <button
          class={primaryButtonClass}
          type="button"
          onClick={() => void renameCurrentSession()}
          disabled={!props.session}
        >
          Rename
        </button>
        <button
          class={secondaryButtonClass}
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
    <section
      class="min-h-[280px] flex-1 overflow-auto rounded-lg border border-[#cbd2ca] bg-white p-[18px]"
      aria-label="Event log"
    >
      <Show
        when={props.events.length > 0}
        fallback={<span class={emptyStateClass}>No events yet</span>}
      >
        <ol class={`${listClass} gap-3`}>
          <For each={props.events}>{(item) => <EventLogRow item={item} />}</For>
        </ol>
      </Show>
    </section>
  );
}

function EventLogRow(props: { item: DomainLogItem }) {
  const [collapsed, setCollapsed] = createSignal(true);
  const title = createMemo(() => eventTitle(props.item.name));
  const eventClass = createMemo(() => eventRowClass(props.item.name));
  const collapsible = createMemo(
    () =>
      props.item.name === domainEventNames.agentExecuted ||
      props.item.name === domainEventNames.executionCompleted,
  );
  const toggleLabel = createMemo(() => (collapsed() ? "Expand" : "Collapse"));

  return (
    <li class={eventClass()}>
      <div class="flex items-center justify-between gap-3">
        <span class="text-xs font-bold uppercase text-[#4f5a55]">{title()}</span>
        <time class="text-xs text-[#66706a]">
          {new Date(props.item.createdAt).toLocaleString()}
        </time>
      </div>
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
        class="w-full min-w-0 cursor-pointer rounded-lg border border-[#c8c2b3] bg-white px-2.5 pb-1 pt-0 text-xs leading-[1.1] text-[#4f4534]"
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
          className: systemTextClass,
          text: props.item.data.session_path,
        } as const;
      case domainEventNames.userMessaged:
        return {
          element: "p",
          className: messageTextClass,
          text: props.item.data.user_message,
        } as const;
      case domainEventNames.agentResponded:
        return {
          element: "p",
          className: messageTextClass,
          text: props.item.data.agent_response,
        } as const;
      case domainEventNames.agentExecuted:
        return {
          element: "pre",
          className: codeOutputClass,
          text: props.item.data.harlan_executed,
        } as const;
      case domainEventNames.executionCompleted:
        return {
          element: "pre",
          className: codeOutputClass,
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
              props.collapsed ? "max-h-12 overflow-hidden" : ""
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
    <form class="grid gap-3" onSubmit={submitPrompt}>
      <textarea
        class="w-full resize-y rounded-lg border border-[#cbd2ca] bg-white p-3.5 leading-normal text-[#17201d] focus:border-[#2f6f7e] focus:outline-3 focus:outline-[#cce7ed]"
        value={prompt()}
        onInput={(event) => setPrompt(event.currentTarget.value)}
        placeholder="Ask Harlan to inspect the repo, summarize files, or continue this session."
        rows={8}
      />
      <button
        class={primaryButtonClass}
        type="submit"
        disabled={!prompt().trim() || props.disabled}
      >
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
        draft.harlanBindings = payload.harlanBindings;
        draft.streamError = "";
        continue;
      }

      if (parsedEvent.event === "sessionUpdated") {
        const payload = readEventPayload<SessionUpdatedPayload>(parsedEvent);
        draft.session = payload.session;
        if (payload.harlanBindings) {
          draft.harlanBindings = payload.harlanBindings;
        }
        refresh(sessions);
        continue;
      }

      if (parsedEvent.event === "sessionDeleted") {
        draft.session = null;
        draft.events = [];
        draft.harlanBindings = [];
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
    <main class={appShellClass}>
      <SessionSidebar
        sessions={sessions()}
        loading={isPending(sessions)}
        selectedSessionId={selectedSessionId()}
        addSession={() => void addSession()}
        selectSession={(sessionId) => void selectSession(sessionId)}
      />

      <section class="flex min-w-0 flex-col gap-[18px] p-[18px] min-[761px]:p-7">
        <SessionHeader
          session={detail.session}
          status={status()}
          renameSession={renameSession}
          deleteSession={deleteSession}
        />

        <EventLog events={detail.events} />

        <PromptComposer disabled={promptDisabled()} running={running()} submitRun={submitRun} />

        <Show when={error()}>
          <pre class={errorOutputClass}>{error()}</pre>
        </Show>
      </section>
    </main>
  );
}
