import type { SourceLocation, SourceSpan } from "./tokens.ts";

export type HarlanErrorKind = "ParseError" | "RuntimeError" | "ImportError";

export type HarlanErrorHint = {
  label?: string;
  text: string;
};

export type HarlanErrorOptions = {
  hints?: Array<string | HarlanErrorHint>;
};

export class HarlanError extends Error {
  readonly kind: HarlanErrorKind;
  readonly span: SourceSpan | null;
  readonly source: string | null;
  readonly hints: HarlanErrorHint[];

  constructor(
    kind: HarlanErrorKind,
    message: string,
    span?: SourceSpan | null,
    source?: string | null,
    options: HarlanErrorOptions = {},
  ) {
    super(message);
    this.name = kind;
    this.kind = kind;
    this.span = span ?? null;
    this.source = source ?? null;
    this.hints = normalizeHints(options.hints ?? []);
  }

  format(): string {
    const lines = [`${this.kind}: ${this.message}`];

    if (this.span) {
      lines.push(`  at line ${this.span.start.line}, column ${this.span.start.column}`);
    }

    if (this.source && this.span) {
      const sourceLine = this.source.split(/\r?\n/)[this.span.start.line - 1];
      if (sourceLine !== undefined) {
        lines.push(`  ${sourceLine}`);
        lines.push(`  ${" ".repeat(Math.max(0, this.span.start.column - 1))}^`);
      }
    }

    if (this.hints.length === 1) {
      lines.push(`Hint: ${formatHint(this.hints[0]!)}`);
    } else if (this.hints.length > 1) {
      lines.push("Hints:");
      for (const hint of this.hints) {
        lines.push(`  - ${formatHint(hint).replaceAll("\n", "\n    ")}`);
      }
    }

    return lines.join("\n");
  }
}

export class ParseError extends HarlanError {
  constructor(
    message: string,
    span?: SourceSpan | null,
    source?: string | null,
    options?: HarlanErrorOptions,
  ) {
    super("ParseError", message, span, source, options);
  }
}

export class RuntimeError extends HarlanError {
  constructor(
    message: string,
    span?: SourceSpan | null,
    source?: string | null,
    options?: HarlanErrorOptions,
  ) {
    super("RuntimeError", message, span, source, options);
  }
}

export class ImportError extends HarlanError {
  constructor(
    message: string,
    span?: SourceSpan | null,
    source?: string | null,
    options?: HarlanErrorOptions,
  ) {
    super("ImportError", message, span, source, options);
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof HarlanError) {
    return error.format();
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function spanFromLocations(start: SourceLocation, end: SourceLocation): SourceSpan {
  return { start, end };
}

function normalizeHints(hints: Array<string | HarlanErrorHint>): HarlanErrorHint[] {
  return hints.map((hint) => (typeof hint === "string" ? { text: hint } : hint));
}

function formatHint(hint: HarlanErrorHint): string {
  return hint.label ? `${hint.label}: ${hint.text}` : hint.text;
}
