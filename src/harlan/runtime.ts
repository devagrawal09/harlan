import type {
  CallExpression,
  Expression,
  FunctionDeclaration,
  MemberExpression,
  Program,
  Statement,
} from "./ast.ts";
import { ImportError, RuntimeError } from "./errors.ts";
import { parseHarlan } from "./parser.ts";
import { createStdlib, type HarlanModule, type HarlanRunOptions } from "./stdlib.ts";
import type { SourceSpan } from "./tokens.ts";

export type HarlanCallable = (
  args: HarlanValue[],
  context: RuntimeContext,
  span: SourceSpan,
) => Promise<HarlanValue> | HarlanValue;

export type HarlanValue =
  | { kind: "null" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "list"; items: HarlanValue[] }
  | { kind: "record"; fields: Map<string, HarlanValue> }
  | { kind: "function"; call: HarlanCallable; name?: string };

export type HarlanRunResult = {
  value: HarlanValue;
  output: string[];
};

export type RuntimeContext = {
  source: string;
  options: Required<Pick<HarlanRunOptions, "cwd" | "allowShell" | "maxOutputChars">> & {
    env: NodeJS.ProcessEnv;
  };
  output: string[];
};

type Scope = Map<string, HarlanValue>;

export async function runHarlan(
  source: string,
  options: HarlanRunOptions = {},
): Promise<HarlanRunResult> {
  const program = parseHarlan(source);
  return evaluateProgram(program, source, options);
}

export async function evaluateProgram(
  program: Program,
  source: string,
  options: HarlanRunOptions = {},
): Promise<HarlanRunResult> {
  const context: RuntimeContext = {
    source,
    options: {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      allowShell: options.allowShell ?? false,
      maxOutputChars: options.maxOutputChars ?? 20_000,
    },
    output: [],
  };
  const stdlib = createStdlib();
  const scope: Scope = createInitialScope(stdlib);
  let value: HarlanValue = { kind: "null" };

  for (const statement of program.statements) {
    value = await evaluateStatement(statement, scope, context);
  }

  return { value, output: context.output };
}

async function evaluateStatement(
  statement: Statement,
  scope: Scope,
  context: RuntimeContext,
): Promise<HarlanValue> {
  switch (statement.kind) {
    case "LetDeclaration": {
      assertCanBind(scope, statement.name, statement.span, context.source);
      const value = await evaluateExpression(statement.value, scope, context);
      scope.set(statement.name, value);
      return value;
    }
    case "FunctionDeclaration": {
      assertCanBind(scope, statement.name, statement.span, context.source);
      scope.set(statement.name, createUserFunction(statement, scope));
      return { kind: "null" };
    }
    case "ExpressionStatement":
      return evaluateExpression(statement.expression, scope, context);
  }
}

function createInitialScope(stdlib: Map<string, HarlanModule>): Scope {
  return new Map([
    [
      "import",
      {
        kind: "function",
        name: "import",
        call: (args, context, span) => {
          if (args.length !== 1) {
            throw new ImportError(
              `import expected 1 argument but received ${args.length}`,
              span,
              context.source,
            );
          }

          const moduleName = args[0]!;
          if (moduleName.kind !== "string") {
            throw new ImportError("import expected a String module name", span, context.source);
          }

          const module = stdlib.get(moduleName.value);
          if (!module) {
            throw new ImportError(`unknown module \`${moduleName.value}\``, span, context.source);
          }

          return moduleToRecord(module);
        },
      },
    ],
  ]);
}

function moduleToRecord(module: HarlanModule): HarlanValue {
  return {
    kind: "record",
    fields: new Map(module.bindings),
  };
}

function createUserFunction(declaration: FunctionDeclaration, parentScope: Scope): HarlanValue {
  return {
    kind: "function",
    name: declaration.name,
    call: async (args, context, span) => {
      if (args.length !== declaration.params.length) {
        throw new RuntimeError(
          `function \`${declaration.name}\` expected ${declaration.params.length} arguments but received ${args.length}`,
          span,
          context.source,
        );
      }

      const localScope = new Map(parentScope);
      declaration.params.forEach((param, index) => {
        localScope.set(param.name, args[index]!);
      });

      return evaluateExpression(declaration.body, localScope, context);
    },
  };
}

async function evaluateExpression(
  expression: Expression,
  scope: Scope,
  context: RuntimeContext,
): Promise<HarlanValue> {
  switch (expression.kind) {
    case "StringLiteral":
      return { kind: "string", value: expression.value };
    case "NumberLiteral":
      return { kind: "number", value: expression.value };
    case "BooleanLiteral":
      return { kind: "boolean", value: expression.value };
    case "IdentifierExpression": {
      const value = scope.get(expression.name);
      if (!value) {
        throw new RuntimeError(
          `unknown binding \`${expression.name}\``,
          expression.span,
          context.source,
        );
      }
      return value;
    }
    case "ListExpression": {
      const items: HarlanValue[] = [];
      for (const item of expression.items) {
        items.push(await evaluateExpression(item, scope, context));
      }
      return { kind: "list", items };
    }
    case "RecordExpression": {
      const fields = new Map<string, HarlanValue>();
      for (const field of expression.fields) {
        if (fields.has(field.name)) {
          throw new RuntimeError(
            `duplicate record field \`${field.name}\``,
            field.span,
            context.source,
          );
        }
        fields.set(field.name, await evaluateExpression(field.value, scope, context));
      }
      return { kind: "record", fields };
    }
    case "MemberExpression":
      return evaluateMember(expression, scope, context);
    case "CallExpression":
      return evaluateCall(expression, scope, context);
    case "PipelineExpression":
      return evaluatePipeline(expression.left, expression.right, scope, context);
  }
}

async function evaluateMember(
  expression: MemberExpression,
  scope: Scope,
  context: RuntimeContext,
): Promise<HarlanValue> {
  const object = await evaluateExpression(expression.object, scope, context);

  if (object.kind !== "record") {
    throw new RuntimeError(
      "member access requires a record value",
      expression.span,
      context.source,
    );
  }

  const value = object.fields.get(expression.property);
  if (!value) {
    throw new RuntimeError(
      `unknown property \`${expression.property}\``,
      expression.span,
      context.source,
    );
  }

  return value;
}

async function evaluateCall(
  expression: CallExpression,
  scope: Scope,
  context: RuntimeContext,
): Promise<HarlanValue> {
  const callee = await evaluateExpression(expression.callee, scope, context);

  if (callee.kind !== "function") {
    throw new RuntimeError(
      "attempted to call a non-function value",
      expression.span,
      context.source,
    );
  }

  const args: HarlanValue[] = [];
  for (const arg of expression.args) {
    args.push(await evaluateExpression(arg, scope, context));
  }

  return callee.call(args, context, expression.span);
}

async function evaluatePipeline(
  left: Expression,
  right: Expression,
  scope: Scope,
  context: RuntimeContext,
): Promise<HarlanValue> {
  const piped = await evaluateExpression(left, scope, context);

  if (right.kind === "CallExpression") {
    const callee = await evaluateExpression(right.callee, scope, context);
    if (callee.kind !== "function") {
      throw new RuntimeError("pipeline target is not a function", right.span, context.source);
    }

    const args: HarlanValue[] = [piped];
    for (const arg of right.args) {
      args.push(await evaluateExpression(arg, scope, context));
    }

    return callee.call(args, context, right.span);
  }

  const callee = await evaluateExpression(right, scope, context);
  if (callee.kind !== "function") {
    throw new RuntimeError("pipeline target is not a function", right.span, context.source);
  }

  return callee.call([piped], context, right.span);
}

function assertCanBind(scope: Scope, name: string, span: SourceSpan, source: string): void {
  if (scope.has(name)) {
    throw new RuntimeError(`binding \`${name}\` already exists`, span, source);
  }
}
