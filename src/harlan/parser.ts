import type {
  BinaryOperator,
  BindingPattern,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionParam,
  LetDeclaration,
  Program,
  RecordField,
  RecordPatternField,
  Statement,
  TypeAnnotation,
} from "./ast.ts";
import { ParseError } from "./errors.ts";
import { lexHarlan, mergeSpans, type SourceSpan, type Token, type TokenType } from "./tokens.ts";

export function parseHarlan(source: string): Program {
  const parser = new Parser(source, lexHarlan(source));
  return parser.parseProgram();
}

class Parser {
  private readonly source: string;
  private readonly tokens: Token[];
  private current = 0;

  constructor(source: string, tokens: Token[]) {
    this.source = source;
    this.tokens = tokens;
  }

  parseProgram(): Program {
    const statements: Statement[] = [];
    const start = this.peek().span;

    while (!this.check("eof")) {
      if (this.match("let")) {
        statements.push(this.letDeclaration(this.previous().span));
      } else if (this.match("fn")) {
        statements.push(this.functionDeclaration(this.previous().span));
      } else {
        const expression = this.expression();
        statements.push({
          kind: "ExpressionStatement",
          expression,
          span: expression.span,
        });
      }
    }

    const end = this.previous().span;
    return {
      kind: "Program",
      statements,
      span: mergeSpans(start, end),
    };
  }

  private letDeclaration(start: SourceSpan): LetDeclaration {
    const pattern = this.bindingPattern();
    this.consume("equals", "expected `=` after let binding pattern", [
      "Use `let name = expression` or destructure with `let { field } = record`.",
    ]);
    const value = this.expression();

    return {
      kind: "LetDeclaration",
      pattern,
      value,
      span: mergeSpans(start, value.span),
    };
  }

  private functionDeclaration(start: SourceSpan): FunctionDeclaration {
    const name = this.consumeIdentifier("expected function name after `fn`");
    this.consume("lParen", "expected `(` after function name");
    const params: FunctionParam[] = [];

    if (!this.check("rParen")) {
      do {
        const paramName = this.consumeIdentifier("expected parameter name");
        let type: TypeAnnotation | null = null;
        if (this.match("colon")) {
          type = this.typeAnnotation();
        }
        params.push({ name: paramName, type });
      } while (this.match("comma"));
    }

    this.consume("rParen", "expected `)` after parameters", [
      "Function declarations use `fn name(param: Type) = expression`.",
    ]);

    let returnType: TypeAnnotation | null = null;
    if (this.match("arrow")) {
      returnType = this.typeAnnotation();
    }

    this.consume("equals", "expected `=` before function body", [
      "Function declarations use `fn name(param: Type) = expression`.",
    ]);
    const body = this.expression();

    return {
      kind: "FunctionDeclaration",
      name,
      params,
      returnType,
      body,
      span: mergeSpans(start, body.span),
    };
  }

  private typeAnnotation(): TypeAnnotation {
    const token = this.consume("identifier", "expected type name");
    const args: TypeAnnotation[] = [];

    if (this.match("lParen")) {
      do {
        args.push(this.typeAnnotation());
      } while (this.match("comma"));
      this.consume("rParen", "expected `)` after type arguments");
    } else if (this.match("lBracket")) {
      do {
        args.push(this.typeAnnotation());
      } while (this.match("comma"));
      this.consume("rBracket", "expected `]` after type arguments");
    }

    return {
      name: token.lexeme,
      args,
      span: mergeSpans(token.span, this.previous().span),
    };
  }

  private expression(): Expression {
    return this.ifExpression();
  }

  private ifExpression(): Expression {
    if (!this.match("if")) {
      return this.pipeline();
    }

    const start = this.previous().span;
    const condition = this.expression();
    this.consume("then", "expected `then` after if condition", [
      "Use `if condition then value else value`.",
    ]);
    const thenBranch = this.expression();
    this.consume("else", "expected `else` after then branch", [
      "Harlan `if` expressions always include both branches: `if condition then value else value`.",
    ]);
    const elseBranch = this.expression();

    return {
      kind: "IfExpression",
      condition,
      thenBranch,
      elseBranch,
      span: mergeSpans(start, elseBranch.span),
    };
  }

  private pipeline(): Expression {
    let expression = this.or();

    while (this.match("pipe")) {
      const right = this.or();
      expression = {
        kind: "PipelineExpression",
        left: expression,
        right,
        span: mergeSpans(expression.span, right.span),
      };
    }

    return expression;
  }

  private or(): Expression {
    let expression = this.and();

    while (this.match("or")) {
      expression = this.binaryExpression(expression, "or", this.and());
    }

    return expression;
  }

  private and(): Expression {
    let expression = this.equality();

    while (this.match("and")) {
      expression = this.binaryExpression(expression, "and", this.equality());
    }

    return expression;
  }

  private equality(): Expression {
    let expression = this.comparison();

    while (this.match("equalEqual", "bangEqual")) {
      const operator = this.previous().type === "equalEqual" ? "==" : "!=";
      expression = this.binaryExpression(expression, operator, this.comparison());
    }

    return expression;
  }

  private comparison(): Expression {
    let expression = this.unary();

    while (this.match("less", "lessEqual", "greater", "greaterEqual")) {
      const operatorByToken: Record<string, BinaryOperator> = {
        less: "<",
        lessEqual: "<=",
        greater: ">",
        greaterEqual: ">=",
      };
      expression = this.binaryExpression(
        expression,
        operatorByToken[this.previous().type]!,
        this.unary(),
      );
    }

    return expression;
  }

  private unary(): Expression {
    if (this.match("not")) {
      const operator = this.previous();
      const argument = this.unary();
      return {
        kind: "UnaryExpression",
        operator: "not",
        argument,
        span: mergeSpans(operator.span, argument.span),
      };
    }

    return this.call();
  }

  private binaryExpression(
    left: Expression,
    operator: BinaryOperator,
    right: Expression,
  ): Expression {
    return {
      kind: "BinaryExpression",
      operator,
      left,
      right,
      span: mergeSpans(left.span, right.span),
    };
  }

  private call(): Expression {
    let expression = this.primary();

    while (true) {
      if (this.match("lParen")) {
        expression = this.finishCall(expression);
      } else if (this.match("dot")) {
        const property = this.consumeIdentifier("expected property name after `.`");
        expression = {
          kind: "MemberExpression",
          object: expression,
          property,
          span: mergeSpans(expression.span, this.previous().span),
        };
      } else {
        break;
      }
    }

    return expression;
  }

  private finishCall(callee: Expression): CallExpression {
    const args: Expression[] = [];

    if (!this.check("rParen")) {
      do {
        args.push(this.expression());
      } while (this.match("comma"));
    }

    const close = this.consume("rParen", "expected `)` after arguments", [
      'Close function calls with `)`, for example `fs.read("README.md")`.',
    ]);
    return {
      kind: "CallExpression",
      callee,
      args,
      span: mergeSpans(callee.span, close.span),
    };
  }

  private primary(): Expression {
    if (this.match("string")) {
      const token = this.previous();
      return {
        kind: "StringLiteral",
        value: String(token.value ?? ""),
        span: token.span,
      };
    }

    if (this.match("number")) {
      const token = this.previous();
      return {
        kind: "NumberLiteral",
        value: Number(token.value),
        span: token.span,
      };
    }

    if (this.match("true", "false")) {
      const token = this.previous();
      return {
        kind: "BooleanLiteral",
        value: token.type === "true",
        span: token.span,
      };
    }

    if (this.match("null")) {
      return {
        kind: "NullLiteral",
        span: this.previous().span,
      };
    }

    if (this.match("identifier")) {
      const token = this.previous();
      return {
        kind: "IdentifierExpression",
        name: token.lexeme,
        span: token.span,
      };
    }

    if (this.match("lParen")) {
      const expression = this.expression();
      this.consume("rParen", "expected `)` after expression", [
        "Close parenthesized expressions with `)`.",
      ]);
      return expression;
    }

    if (this.match("lBracket")) {
      return this.listExpression(this.previous().span);
    }

    if (this.match("lBrace")) {
      return this.recordExpression(this.previous().span);
    }

    throw this.error(this.peek(), "expected expression", [
      "Expressions can start with a string, number, boolean, null, identifier, list, record, parenthesized expression, or `if`.",
    ]);
  }

  private bindingPattern(): BindingPattern {
    if (this.match("identifier")) {
      const token = this.previous();
      return {
        kind: "IdentifierPattern",
        name: token.lexeme,
        span: token.span,
      };
    }

    if (this.match("lBrace")) {
      return this.recordPattern(this.previous().span);
    }

    if (this.match("lBracket")) {
      return this.listPattern(this.previous().span);
    }

    throw this.error(this.peek(), "expected binding pattern", [
      "A `let` binding needs a name or destructuring pattern, for example `let name = expression`.",
    ]);
  }

  private recordPattern(start: SourceSpan): BindingPattern {
    const fields: RecordPatternField[] = [];

    if (!this.check("rBrace")) {
      do {
        const nameToken = this.consume("identifier", "expected record pattern field name");
        let pattern: BindingPattern = {
          kind: "IdentifierPattern",
          name: nameToken.lexeme,
          span: nameToken.span,
        };

        if (this.match("colon")) {
          pattern = this.bindingPattern();
        }

        fields.push({
          name: nameToken.lexeme,
          pattern,
          span: mergeSpans(nameToken.span, pattern.span),
        });
      } while (this.match("comma"));
    }

    const close = this.consume("rBrace", "expected `}` after record pattern", [
      "Close record destructuring patterns with `}`.",
    ]);
    return {
      kind: "RecordPattern",
      fields,
      span: mergeSpans(start, close.span),
    };
  }

  private listPattern(start: SourceSpan): BindingPattern {
    const items: BindingPattern[] = [];

    if (!this.check("rBracket")) {
      do {
        items.push(this.bindingPattern());
      } while (this.match("comma"));
    }

    const close = this.consume("rBracket", "expected `]` after list pattern", [
      "Close list destructuring patterns with `]`.",
    ]);
    return {
      kind: "ListPattern",
      items,
      span: mergeSpans(start, close.span),
    };
  }

  private listExpression(start: SourceSpan): Expression {
    const items: Expression[] = [];

    if (!this.check("rBracket")) {
      do {
        items.push(this.expression());
      } while (this.match("comma"));
    }

    const close = this.consume("rBracket", "expected `]` after list items", [
      "Close list expressions with `]`.",
    ]);
    return {
      kind: "ListExpression",
      items,
      span: mergeSpans(start, close.span),
    };
  }

  private recordExpression(start: SourceSpan): Expression {
    const fields: RecordField[] = [];

    if (!this.check("rBrace")) {
      do {
        const nameToken = this.consume("identifier", "expected record field name");
        this.consume("colon", "expected `:` after record field name");
        const value = this.expression();
        fields.push({
          name: nameToken.lexeme,
          value,
          span: mergeSpans(nameToken.span, value.span),
        });
      } while (this.match("comma"));
    }

    const close = this.consume("rBrace", "expected `}` after record fields", [
      "Close record expressions with `}`.",
    ]);
    return {
      kind: "RecordExpression",
      fields,
      span: mergeSpans(start, close.span),
    };
  }

  private match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }

    return false;
  }

  private consume(type: TokenType, message: string, hints: string[] = []): Token {
    if (this.check(type)) {
      return this.advance();
    }

    throw this.error(this.peek(), message, hints);
  }

  private consumeIdentifier(message: string): string {
    return this.consume("identifier", message).lexeme;
  }

  private check(type: TokenType): boolean {
    if (this.isAtEnd()) {
      return type === "eof";
    }

    return this.peek().type === type;
  }

  private advance(): Token {
    if (!this.isAtEnd()) {
      this.current += 1;
    }

    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.peek().type === "eof";
  }

  private peek(): Token {
    return this.tokens[this.current] ?? this.tokens[this.tokens.length - 1]!;
  }

  private previous(): Token {
    return this.tokens[this.current - 1] ?? this.tokens[0]!;
  }

  private error(token: Token, message: string, hints: string[] = []): ParseError {
    return new ParseError(message, token.span, this.source, { hints });
  }
}
