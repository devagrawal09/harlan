import { ParseError } from "./errors.ts";

export type SourceLocation = {
  offset: number;
  line: number;
  column: number;
};

export type SourceSpan = {
  start: SourceLocation;
  end: SourceLocation;
};

export type TokenType =
  | "identifier"
  | "string"
  | "number"
  | "let"
  | "fn"
  | "if"
  | "then"
  | "else"
  | "and"
  | "or"
  | "not"
  | "null"
  | "true"
  | "false"
  | "lParen"
  | "rParen"
  | "lBrace"
  | "rBrace"
  | "lBracket"
  | "rBracket"
  | "comma"
  | "colon"
  | "dot"
  | "equals"
  | "equalEqual"
  | "bangEqual"
  | "less"
  | "lessEqual"
  | "greater"
  | "greaterEqual"
  | "arrow"
  | "pipe"
  | "eof";

export type Token = {
  type: TokenType;
  lexeme: string;
  span: SourceSpan;
  value?: string | number;
};

const keywords = new Map<string, TokenType>([
  ["let", "let"],
  ["fn", "fn"],
  ["if", "if"],
  ["then", "then"],
  ["else", "else"],
  ["and", "and"],
  ["or", "or"],
  ["not", "not"],
  ["null", "null"],
  ["true", "true"],
  ["false", "false"],
]);

export function lexHarlan(source: string): Token[] {
  const lexer = new Lexer(source);
  return lexer.lex();
}

export function mergeSpans(start: SourceSpan, end: SourceSpan): SourceSpan {
  return { start: start.start, end: end.end };
}

class Lexer {
  private readonly source: string;
  private readonly tokens: Token[] = [];
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(source: string) {
    this.source = source;
  }

  lex(): Token[] {
    while (!this.isAtEnd()) {
      this.scanToken();
    }

    const location = this.location();
    this.tokens.push({
      type: "eof",
      lexeme: "",
      span: { start: location, end: location },
    });
    return this.tokens;
  }

  private scanToken(): void {
    const char = this.peek();

    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      this.advance();
      return;
    }

    if (char === "/" && this.peekNext() === "/") {
      this.skipComment();
      return;
    }

    if (isAlpha(char) || char === "_") {
      this.identifier();
      return;
    }

    if (isDigit(char)) {
      this.number();
      return;
    }

    if (char === '"') {
      this.string();
      return;
    }

    const start = this.location();
    const consumed = this.advance();

    switch (consumed) {
      case "(":
        this.add("lParen", consumed, start);
        return;
      case ")":
        this.add("rParen", consumed, start);
        return;
      case "{":
        this.add("lBrace", consumed, start);
        return;
      case "}":
        this.add("rBrace", consumed, start);
        return;
      case "[":
        this.add("lBracket", consumed, start);
        return;
      case "]":
        this.add("rBracket", consumed, start);
        return;
      case ",":
        this.add("comma", consumed, start);
        return;
      case ":":
        this.add("colon", consumed, start);
        return;
      case ".":
        this.add("dot", consumed, start);
        return;
      case "=":
        if (this.match("=")) {
          this.add("equalEqual", "==", start);
          return;
        }
        this.add("equals", consumed, start);
        return;
      case "!":
        if (this.match("=")) {
          this.add("bangEqual", "!=", start);
          return;
        }
        break;
      case "<":
        if (this.match("=")) {
          this.add("lessEqual", "<=", start);
          return;
        }
        this.add("less", consumed, start);
        return;
      case ">":
        if (this.match("=")) {
          this.add("greaterEqual", ">=", start);
          return;
        }
        this.add("greater", consumed, start);
        return;
      case "-":
        if (this.match(">")) {
          this.add("arrow", "->", start);
          return;
        }
        break;
      case "|":
        if (this.match(">")) {
          this.add("pipe", "|>", start);
          return;
        }
        break;
    }

    const hints = hintsForUnexpectedCharacter(consumed);
    throw new ParseError(
      `unexpected character \`${consumed}\``,
      { start, end: this.location() },
      this.source,
      { hints },
    );
  }

  private identifier(): void {
    const start = this.location();
    let text = "";

    while (!this.isAtEnd() && (isAlphaNumeric(this.peek()) || this.peek() === "_")) {
      text += this.advance();
    }

    this.tokens.push({
      type: keywords.get(text) ?? "identifier",
      lexeme: text,
      span: { start, end: this.location() },
      value: text,
    });
  }

  private number(): void {
    const start = this.location();
    let text = "";

    while (!this.isAtEnd() && isDigit(this.peek())) {
      text += this.advance();
    }

    if (this.peek() === "." && isDigit(this.peekNext())) {
      text += this.advance();
      while (!this.isAtEnd() && isDigit(this.peek())) {
        text += this.advance();
      }
    }

    this.tokens.push({
      type: "number",
      lexeme: text,
      span: { start, end: this.location() },
      value: Number(text),
    });
  }

  private string(): void {
    const start = this.location();
    this.advance();
    let value = "";

    while (!this.isAtEnd() && this.peek() !== '"') {
      const char = this.advance();
      if (char === "\\") {
        value += this.escape(start);
      } else {
        value += char;
      }
    }

    if (this.isAtEnd()) {
      throw new ParseError("unterminated string", { start, end: this.location() }, this.source, {
        hints: [
          'Close strings with a double quote. Supported escapes include `\\n`, `\\r`, `\\t`, `\\"`, and `\\\\`.',
        ],
      });
    }

    this.advance();
    this.tokens.push({
      type: "string",
      lexeme: this.source.slice(start.offset, this.offset),
      span: { start, end: this.location() },
      value,
    });
  }

  private escape(start: SourceLocation): string {
    if (this.isAtEnd()) {
      throw new ParseError(
        "unterminated string escape",
        { start, end: this.location() },
        this.source,
        {
          hints: ['Supported string escapes include `\\n`, `\\r`, `\\t`, `\\"`, and `\\\\`.'],
        },
      );
    }

    const char = this.advance();
    switch (char) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return char;
    }
  }

  private skipComment(): void {
    while (!this.isAtEnd() && this.peek() !== "\n") {
      this.advance();
    }
  }

  private add(type: TokenType, lexeme: string, start: SourceLocation): void {
    this.tokens.push({
      type,
      lexeme,
      span: { start, end: this.location() },
    });
  }

  private match(expected: string): boolean {
    if (this.isAtEnd() || this.peek() !== expected) {
      return false;
    }

    this.advance();
    return true;
  }

  private advance(): string {
    const char = this.source[this.offset] ?? "";
    this.offset += 1;

    if (char === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }

    return char;
  }

  private peek(): string {
    return this.source[this.offset] ?? "\0";
  }

  private peekNext(): string {
    return this.source[this.offset + 1] ?? "\0";
  }

  private isAtEnd(): boolean {
    return this.offset >= this.source.length;
  }

  private location(): SourceLocation {
    return {
      offset: this.offset,
      line: this.line,
      column: this.column,
    };
  }
}

function hintsForUnexpectedCharacter(char: string): string[] {
  if (char === ";") {
    return ["Harlan expressions do not use semicolons; put each statement on its own line."];
  }

  if (char === "'") {
    return ['Strings use double quotes, for example `let name = "README.md"`.'];
  }

  if (char === "$" || char === "`") {
    return [
      'Shell syntax is not Harlan syntax. Import shell and call `shell.run("command")` only when shell execution is needed.',
    ];
  }

  return [];
}

function isAlpha(char: string): boolean {
  return /^[A-Za-z]$/.test(char);
}

function isDigit(char: string): boolean {
  return /^[0-9]$/.test(char);
}

function isAlphaNumeric(char: string): boolean {
  return isAlpha(char) || isDigit(char);
}
