export type SseEvent = {
  event: string;
  data: string;
};

export class SseEventParser {
  #buffer = "";

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const events: SseEvent[] = [];
    let boundary = this.#findBoundary();

    while (boundary) {
      const [index, length] = boundary;
      const rawEvent = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + length);

      const parsed = parseSseEvent(rawEvent);

      if (parsed) {
        events.push(parsed);
      }

      boundary = this.#findBoundary();
    }

    return events;
  }

  flush(): SseEvent[] {
    if (!this.#buffer.trim()) {
      this.#buffer = "";
      return [];
    }

    const parsed = parseSseEvent(this.#buffer);
    this.#buffer = "";
    return parsed ? [parsed] : [];
  }

  #findBoundary(): [index: number, length: number] | null {
    const crlf = this.#buffer.indexOf("\r\n\r\n");
    const lf = this.#buffer.indexOf("\n\n");

    if (crlf === -1 && lf === -1) {
      return null;
    }

    if (crlf !== -1 && (lf === -1 || crlf < lf)) {
      return [crlf, 4];
    }

    return [lf, 2];
  }
}

export function parseSseEvent(rawEvent: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];

  for (const line of rawEvent.replaceAll("\r\n", "\n").split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

    if (field === "event") {
      event = value;
    }

    if (field === "data") {
      data.push(value);
    }
  }

  if (data.length === 0) {
    return null;
  }

  return {
    event,
    data: data.join("\n"),
  };
}
