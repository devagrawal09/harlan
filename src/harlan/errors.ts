import type { SourceLocation, SourceSpan } from "./tokens.ts";

export type HarlanErrorKind = "ParseError" | "RuntimeError" | "ImportError";

export class HarlanError extends Error {
  readonly kind: HarlanErrorKind;
  readonly span: SourceSpan | null;
  readonly source: string | null;

  constructor(
    kind: HarlanErrorKind,
    message: string,
    span?: SourceSpan | null,
    source?: string | null,
  ) {
    super(message);
    this.name = kind;
    this.kind = kind;
    this.span = span ?? null;
    this.source = source ?? null;
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

    return lines.join("\n");
  }
}

export class ParseError extends HarlanError {
  constructor(message: string, span?: SourceSpan | null, source?: string | null) {
    super("ParseError", message, span, source);
  }
}

export class RuntimeError extends HarlanError {
  constructor(message: string, span?: SourceSpan | null, source?: string | null) {
    super("RuntimeError", message, span, source);
  }
}

export class ImportError extends HarlanError {
  constructor(message: string, span?: SourceSpan | null, source?: string | null) {
    super("ImportError", message, span, source);
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
