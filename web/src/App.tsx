import { createSignal } from "solid-js";
import { For, Show } from "@solidjs/web";
import { SseEventParser, type SseEvent } from "./events";

type RunStatus = "idle" | "running" | "done" | "error";

type TimelineEvent = SseEvent & {
  id: number;
};

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

export default function App() {
  const [prompt, setPrompt] = createSignal("");
  const [status, setStatus] = createSignal<RunStatus>("idle");
  const [answer, setAnswer] = createSignal("");
  const [events, setEvents] = createSignal<TimelineEvent[]>([]);
  const [error, setError] = createSignal("");
  let nextEventId = 1;

  async function submitRun(event: SubmitEvent) {
    event.preventDefault();

    const trimmedPrompt = prompt().trim();

    if (!trimmedPrompt || status() === "running") {
      return;
    }

    setStatus("running");
    setAnswer("");
    setEvents([]);
    setError("");

    try {
      const response = await fetch("/api/runs", {
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
      <section class="run-pane">
        <div class="toolbar">
          <div>
            <h1>Harlan</h1>
            <p>Agent run console</p>
          </div>
          <span class={`status status-${status()}`}>{status()}</span>
        </div>

        <form class="prompt-form" onSubmit={submitRun}>
          <textarea
            value={prompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
            placeholder="Ask Harlan to inspect the repo, summarize files, or run a deterministic workflow."
            rows={8}
          />
          <button type="submit" disabled={!prompt().trim() || status() === "running"}>
            {status() === "running" ? "Running" : "Run"}
          </button>
        </form>

        <Show when={error()}>
          <pre class="error-output">{error()}</pre>
        </Show>

        <section class="output-panel" aria-label="Agent response">
          <Show when={answer()} fallback={<span class="empty-state">No response yet</span>}>
            <pre>{answer()}</pre>
          </Show>
        </section>
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
