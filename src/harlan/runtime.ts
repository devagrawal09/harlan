import type {
  BinaryExpression,
  BindingPattern,
  CallExpression,
  Expression,
  FunctionDeclaration,
  MemberExpression,
  Program,
  Statement,
  UnaryExpression,
} from "./ast.ts";
import { ImportError, RuntimeError } from "./errors.ts";
import { parseHarlan } from "./parser.ts";
import {
  createStdlib,
  type HarlanBindingSummary,
  type HarlanModule,
  type HarlanRunOptions,
  type HarlanSessionSnapshot,
  type SerializedHarlanValue,
} from "./stdlib.ts";
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
  | { kind: "record"; fields: Map<string, HarlanValue>; moduleName?: string }
  | {
      kind: "function";
      call: HarlanCallable;
      name?: string;
      stdlibName?: string;
      declaration?: FunctionDeclaration;
      closure?: Map<string, HarlanValue>;
    };

export type HarlanRunResult = {
  value: HarlanValue;
  output: string[];
  sessionSnapshot: HarlanSessionSnapshot;
  warnings: string[];
};

export type RuntimeContext = {
  source: string;
  options: Required<Pick<HarlanRunOptions, "cwd" | "allowShell" | "maxOutputChars">> & {
    env: NodeJS.ProcessEnv;
    maxSessionStateChars: number | null;
  };
  output: string[];
  stdlib: Map<string, HarlanModule>;
  warnings: string[];
};

type Scope = Map<string, HarlanValue>;
const knownModuleNames = new Set(["fs", "text", "format", "shell"]);
const defaultSessionSnapshot: HarlanSessionSnapshot = { bindings: {}, importedModules: [] };
const runStateSymbol = Symbol("harlanRunState");

export type HarlanRunState = {
  sessionSnapshot: HarlanSessionSnapshot;
  warnings: string[];
};

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
  const stdlib = createStdlib();
  const context: RuntimeContext = {
    source,
    options: {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      allowShell: options.allowShell ?? false,
      maxOutputChars: options.maxOutputChars ?? 20_000,
      maxSessionStateChars: options.maxSessionStateChars ?? null,
    },
    output: [],
    stdlib,
    warnings: [],
  };
  const initialScope = createInitialScope(stdlib);
  const scope: Scope = restoreSessionSnapshot(options.sessionSnapshot, initialScope, stdlib);
  let value: HarlanValue = { kind: "null" };
  let sessionSnapshot = snapshotFromScope(scope, initialScope);

  for (const statement of program.statements) {
    const before = new Map(scope);
    try {
      value = await evaluateStatement(statement, scope, context);
      const nextSnapshot = snapshotFromScope(scope, initialScope);
      assertSnapshotSize(nextSnapshot, context, statement.span);
      sessionSnapshot = nextSnapshot;
    } catch (error) {
      replaceScope(scope, before);
      attachRunState(error, sessionSnapshot, context.warnings);
      throw error;
    }
  }

  return {
    value,
    output: context.output,
    sessionSnapshot,
    warnings: context.warnings,
  };
}

export function getHarlanRunState(error: unknown): HarlanRunState | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  return (error as { [runStateSymbol]?: HarlanRunState })[runStateSymbol] ?? null;
}

export function summarizeHarlanSessionSnapshot(
  snapshot: HarlanSessionSnapshot = defaultSessionSnapshot,
): HarlanBindingSummary[] {
  return Object.entries(snapshot.bindings)
    .map(([name, value]) => ({ name, kind: summarizeSerializedKind(value) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function evaluateStatement(
  statement: Statement,
  scope: Scope,
  context: RuntimeContext,
): Promise<HarlanValue> {
  switch (statement.kind) {
    case "LetDeclaration": {
      const duplicateImport = maybeHandleDuplicateImport(statement, scope, context);
      if (duplicateImport) {
        return duplicateImport;
      }

      const value = await evaluateExpression(statement.value, scope, context);
      bindPattern(statement.pattern, value, scope, context);
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
        stdlibName: "import",
        call: (args, context, span) => {
          if (args.length !== 1) {
            throw new ImportError(
              `import expected 1 argument but received ${args.length}`,
              span,
              context.source,
              {
                hints: [
                  'Import modules with exactly one string argument, for example `let fs = import("fs")`.',
                ],
              },
            );
          }

          const moduleName = args[0]!;
          if (moduleName.kind !== "string") {
            throw new ImportError("import expected a String module name", span, context.source, {
              hints: ['Use a quoted module name, for example `let text = import("text")`.'],
            });
          }

          const module = stdlib.get(moduleName.value);
          if (!module) {
            throw new ImportError(`unknown module \`${moduleName.value}\``, span, context.source, {
              hints: ["Available modules are `fs`, `text`, `format`, and `shell`."],
            });
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
    moduleName: module.name,
  };
}

function createUserFunction(declaration: FunctionDeclaration, parentScope: Scope): HarlanValue {
  const frozenScope = new Map(parentScope);
  return {
    kind: "function",
    name: declaration.name,
    declaration,
    closure: frozenScope,
    call: async (args, context, span) => {
      if (args.length !== declaration.params.length) {
        throw new RuntimeError(
          `function \`${declaration.name}\` expected ${declaration.params.length} arguments but received ${args.length}`,
          span,
          context.source,
        );
      }

      const localScope = new Map(frozenScope);
      declaration.params.forEach((param, index) => {
        localScope.set(param.name, args[index]!);
      });

      return evaluateExpression(declaration.body, localScope, context);
    },
  };
}

function restoreSessionSnapshot(
  snapshot: HarlanSessionSnapshot | undefined,
  initialScope: Scope,
  stdlib: Map<string, HarlanModule>,
): Scope {
  const scope = new Map(initialScope);

  for (const [name, value] of Object.entries(snapshot?.bindings ?? {})) {
    scope.set(name, deserializeHarlanValue(value, initialScope, stdlib));
  }

  return scope;
}

function snapshotFromScope(scope: Scope, initialScope: Scope): HarlanSessionSnapshot {
  const bindings: Record<string, SerializedHarlanValue> = {};
  const importedModules = new Set<string>();

  for (const [name, value] of scope) {
    if (initialScope.has(name)) {
      continue;
    }

    bindings[name] = serializeHarlanValue(value, initialScope);
    collectImportedModules(value, importedModules);
  }

  return {
    bindings,
    importedModules: [...importedModules].sort(),
  };
}

function serializeHarlanValue(value: HarlanValue, initialScope: Scope): SerializedHarlanValue {
  switch (value.kind) {
    case "null":
      return { kind: "null" };
    case "string":
      return { kind: "string", value: value.value };
    case "number":
      return { kind: "number", value: value.value };
    case "boolean":
      return { kind: "boolean", value: value.value };
    case "list":
      return {
        kind: "list",
        items: value.items.map((item) => serializeHarlanValue(item, initialScope)),
      };
    case "record":
      if (value.moduleName) {
        return { kind: "module", name: value.moduleName };
      }

      return {
        kind: "record",
        fields: Object.fromEntries(
          [...value.fields.entries()].map(([name, fieldValue]) => [
            name,
            serializeHarlanValue(fieldValue, initialScope),
          ]),
        ),
      };
    case "function":
      if (value.stdlibName) {
        return { kind: "stdlibFunction", name: value.stdlibName };
      }

      if (value.declaration && value.closure) {
        return {
          kind: "function",
          name: value.name ?? value.declaration.name,
          declaration: value.declaration,
          closure: Object.fromEntries(
            [...value.closure.entries()].map(([name, closureValue]) => [
              name,
              serializeHarlanValue(closureValue, initialScope),
            ]),
          ),
        };
      }

      throw new RuntimeError(`cannot persist function \`${value.name ?? "anonymous"}\``);
  }
}

function deserializeHarlanValue(
  value: SerializedHarlanValue,
  initialScope: Scope,
  stdlib: Map<string, HarlanModule>,
): HarlanValue {
  switch (value.kind) {
    case "null":
      return { kind: "null" };
    case "string":
      return { kind: "string", value: value.value };
    case "number":
      return { kind: "number", value: value.value };
    case "boolean":
      return { kind: "boolean", value: value.value };
    case "list":
      return {
        kind: "list",
        items: value.items.map((item) => deserializeHarlanValue(item, initialScope, stdlib)),
      };
    case "record":
      return {
        kind: "record",
        fields: new Map(
          Object.entries(value.fields).map(([name, fieldValue]) => [
            name,
            deserializeHarlanValue(fieldValue, initialScope, stdlib),
          ]),
        ),
      };
    case "module": {
      const module = stdlib.get(value.name);
      if (!module) {
        throw new RuntimeError(`cannot restore unknown module \`${value.name}\``);
      }
      return moduleToRecord(module);
    }
    case "stdlibFunction": {
      const restored = findStdlibFunction(value.name, initialScope, stdlib);
      if (!restored) {
        throw new RuntimeError(`cannot restore unknown stdlib function \`${value.name}\``);
      }
      return restored;
    }
    case "function": {
      const closure = new Map(
        Object.entries(value.closure).map(([name, closureValue]) => [
          name,
          deserializeHarlanValue(closureValue, initialScope, stdlib),
        ]),
      );
      return createUserFunctionFromClosure(value.declaration, closure, value.name);
    }
  }
}

function findStdlibFunction(
  name: string,
  initialScope: Scope,
  stdlib: Map<string, HarlanModule>,
): HarlanValue | null {
  if (name === "import") {
    return initialScope.get("import") ?? null;
  }

  const [moduleName, bindingName] = name.split(".");
  if (!moduleName || !bindingName) {
    return null;
  }

  return stdlib.get(moduleName)?.bindings.get(bindingName) ?? null;
}

function createUserFunctionFromClosure(
  declaration: FunctionDeclaration,
  frozenScope: Scope,
  name: string,
): HarlanValue {
  return {
    kind: "function",
    name,
    declaration,
    closure: frozenScope,
    call: async (args, context, span) => {
      if (args.length !== declaration.params.length) {
        throw new RuntimeError(
          `function \`${declaration.name}\` expected ${declaration.params.length} arguments but received ${args.length}`,
          span,
          context.source,
        );
      }

      const localScope = new Map(frozenScope);
      declaration.params.forEach((param, index) => {
        localScope.set(param.name, args[index]!);
      });

      return evaluateExpression(declaration.body, localScope, context);
    },
  };
}

function collectImportedModules(value: HarlanValue, importedModules: Set<string>): void {
  switch (value.kind) {
    case "record":
      if (value.moduleName) {
        importedModules.add(value.moduleName);
        return;
      }
      for (const fieldValue of value.fields.values()) {
        collectImportedModules(fieldValue, importedModules);
      }
      return;
    case "list":
      for (const item of value.items) {
        collectImportedModules(item, importedModules);
      }
      return;
    case "function":
      for (const closureValue of value.closure?.values() ?? []) {
        collectImportedModules(closureValue, importedModules);
      }
      return;
    case "null":
    case "string":
    case "number":
    case "boolean":
      return;
  }
}

function maybeHandleDuplicateImport(
  statement: Statement,
  scope: Scope,
  context: RuntimeContext,
): HarlanValue | null {
  if (
    statement.kind !== "LetDeclaration" ||
    statement.pattern.kind !== "IdentifierPattern" ||
    statement.value.kind !== "CallExpression" ||
    statement.value.callee.kind !== "IdentifierExpression" ||
    statement.value.callee.name !== "import" ||
    statement.value.args.length !== 1 ||
    statement.value.args[0]?.kind !== "StringLiteral"
  ) {
    return null;
  }

  const name = statement.pattern.name;
  const moduleName = statement.value.args[0].value;
  const existing = scope.get(name);
  if (!existing) {
    return null;
  }

  if (existing.kind === "record" && existing.moduleName === moduleName && name === moduleName) {
    context.warnings.push(
      `Warning: ${name} is already imported in this session; use ${name} directly in later scripts.`,
    );
    return existing;
  }

  return null;
}

function assertSnapshotSize(
  snapshot: HarlanSessionSnapshot,
  context: RuntimeContext,
  span: SourceSpan,
): void {
  if (context.options.maxSessionStateChars === null) {
    return;
  }

  const size = JSON.stringify(snapshot).length;
  if (size > context.options.maxSessionStateChars) {
    throw new RuntimeError(
      `persisted Harlan session state exceeds ${context.options.maxSessionStateChars} characters`,
      span,
      context.source,
    );
  }
}

function replaceScope(scope: Scope, replacement: Scope): void {
  scope.clear();
  for (const [name, value] of replacement) {
    scope.set(name, value);
  }
}

function attachRunState(
  error: unknown,
  sessionSnapshot: HarlanSessionSnapshot,
  warnings: string[],
): void {
  if (!error || typeof error !== "object") {
    return;
  }

  (error as { [runStateSymbol]?: HarlanRunState })[runStateSymbol] = {
    sessionSnapshot,
    warnings: [...warnings],
  };
}

function summarizeSerializedKind(value: SerializedHarlanValue): HarlanBindingSummary["kind"] {
  switch (value.kind) {
    case "module":
      return "module";
    case "stdlibFunction":
    case "function":
      return "function";
    default:
      return value.kind;
  }
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
    case "NullLiteral":
      return { kind: "null" };
    case "IfExpression": {
      const condition = await evaluateExpression(expression.condition, scope, context);
      if (condition.kind !== "boolean") {
        throw new RuntimeError(
          "if condition must be a boolean",
          expression.condition.span,
          context.source,
          {
            hints: [
              'Use an explicit boolean expression, for example `fs.exists("README.md")` or `info.size > 0`.',
            ],
          },
        );
      }

      return evaluateExpression(
        condition.value ? expression.thenBranch : expression.elseBranch,
        scope,
        context,
      );
    }
    case "BinaryExpression":
      return evaluateBinary(expression, scope, context);
    case "UnaryExpression":
      return evaluateUnary(expression, scope, context);
    case "IdentifierExpression": {
      const value = scope.get(expression.name);
      if (!value) {
        throw new RuntimeError(
          `unknown binding \`${expression.name}\``,
          expression.span,
          context.source,
          { hints: unknownBindingHints(expression.name) },
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

async function evaluateUnary(
  expression: UnaryExpression,
  scope: Scope,
  context: RuntimeContext,
): Promise<HarlanValue> {
  const argument = await evaluateExpression(expression.argument, scope, context);
  if (argument.kind !== "boolean") {
    throw new RuntimeError("not operand must be a boolean", expression.span, context.source, {
      hints: [booleanOperandHint()],
    });
  }

  return { kind: "boolean", value: !argument.value };
}

async function evaluateBinary(
  expression: BinaryExpression,
  scope: Scope,
  context: RuntimeContext,
): Promise<HarlanValue> {
  if (expression.operator === "and") {
    const left = await evaluateExpression(expression.left, scope, context);
    if (left.kind !== "boolean") {
      throw new RuntimeError(
        "and left operand must be a boolean",
        expression.left.span,
        context.source,
        { hints: [booleanOperandHint()] },
      );
    }
    if (!left.value) {
      return { kind: "boolean", value: false };
    }

    const right = await evaluateExpression(expression.right, scope, context);
    if (right.kind !== "boolean") {
      throw new RuntimeError(
        "and right operand must be a boolean",
        expression.right.span,
        context.source,
        { hints: [booleanOperandHint()] },
      );
    }
    return { kind: "boolean", value: right.value };
  }

  if (expression.operator === "or") {
    const left = await evaluateExpression(expression.left, scope, context);
    if (left.kind !== "boolean") {
      throw new RuntimeError(
        "or left operand must be a boolean",
        expression.left.span,
        context.source,
        { hints: [booleanOperandHint()] },
      );
    }
    if (left.value) {
      return { kind: "boolean", value: true };
    }

    const right = await evaluateExpression(expression.right, scope, context);
    if (right.kind !== "boolean") {
      throw new RuntimeError(
        "or right operand must be a boolean",
        expression.right.span,
        context.source,
        { hints: [booleanOperandHint()] },
      );
    }
    return { kind: "boolean", value: right.value };
  }

  const left = await evaluateExpression(expression.left, scope, context);
  const right = await evaluateExpression(expression.right, scope, context);

  switch (expression.operator) {
    case "==":
      return { kind: "boolean", value: valuesEqual(left, right) };
    case "!=":
      return { kind: "boolean", value: !valuesEqual(left, right) };
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compareValues(expression.operator, left, right, context, expression.span);
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
      {
        hints: [
          "Use member access on records returned from imports or record expressions, for example `fs.read` or `task.path`.",
        ],
      },
    );
  }

  const value = object.fields.get(expression.property);
  if (!value) {
    throw new RuntimeError(
      `unknown property \`${expression.property}\``,
      expression.span,
      context.source,
      { hints: unknownPropertyHints(object) },
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
      {
        hints: ["Only imported module functions and functions declared with `fn` can be called."],
      },
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
      throw new RuntimeError("pipeline target is not a function", right.span, context.source, {
        hints: [pipelineHint()],
      });
    }

    const args: HarlanValue[] = [piped];
    for (const arg of right.args) {
      args.push(await evaluateExpression(arg, scope, context));
    }

    return callee.call(args, context, right.span);
  }

  const callee = await evaluateExpression(right, scope, context);
  if (callee.kind !== "function") {
    throw new RuntimeError("pipeline target is not a function", right.span, context.source, {
      hints: [pipelineHint()],
    });
  }

  return callee.call([piped], context, right.span);
}

function assertCanBind(scope: Scope, name: string, span: SourceSpan, source: string): void {
  if (scope.has(name)) {
    throw new RuntimeError(`binding \`${name}\` already exists`, span, source);
  }
}

function bindPattern(
  pattern: BindingPattern,
  value: HarlanValue,
  scope: Scope,
  context: RuntimeContext,
): void {
  const names = collectPatternNames(pattern);
  const seen = new Set<string>();

  for (const { name, span } of names) {
    if (seen.has(name)) {
      throw new RuntimeError(`duplicate binding \`${name}\` in pattern`, span, context.source);
    }
    seen.add(name);
    assertCanBind(scope, name, span, context.source);
  }

  const bindings = resolvePatternBindings(pattern, value, context);
  for (const [name, boundValue] of bindings) {
    scope.set(name, boundValue);
  }
}

function collectPatternNames(pattern: BindingPattern): Array<{ name: string; span: SourceSpan }> {
  switch (pattern.kind) {
    case "IdentifierPattern":
      return [{ name: pattern.name, span: pattern.span }];
    case "RecordPattern":
      return pattern.fields.flatMap((field) => collectPatternNames(field.pattern));
    case "ListPattern":
      return pattern.items.flatMap(collectPatternNames);
  }
}

function resolvePatternBindings(
  pattern: BindingPattern,
  value: HarlanValue,
  context: RuntimeContext,
): Array<[string, HarlanValue]> {
  switch (pattern.kind) {
    case "IdentifierPattern":
      return [[pattern.name, value]];
    case "RecordPattern":
      if (value.kind !== "record") {
        throw new RuntimeError(
          "record destructuring requires a record value",
          pattern.span,
          context.source,
          { hints: ["Destructure records with `let { field } = recordValue`."] },
        );
      }
      return pattern.fields.flatMap((field) =>
        resolvePatternBindings(
          field.pattern,
          value.fields.get(field.name) ?? { kind: "null" },
          context,
        ),
      );
    case "ListPattern":
      if (value.kind !== "list") {
        throw new RuntimeError(
          "list destructuring requires a list value",
          pattern.span,
          context.source,
          { hints: ["Destructure lists with `let [first, second] = listValue`."] },
        );
      }
      return pattern.items.flatMap((item, index) =>
        resolvePatternBindings(item, value.items[index] ?? { kind: "null" }, context),
      );
  }
}

function valuesEqual(left: HarlanValue, right: HarlanValue): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "null":
      return true;
    case "string":
    case "number":
    case "boolean":
      return left.value === (right as { value: string | number | boolean }).value;
    case "function":
      return left === right;
    case "list": {
      const rightList = right as typeof left;
      return (
        left.items.length === rightList.items.length &&
        left.items.every((item, index) => valuesEqual(item, rightList.items[index]!))
      );
    }
    case "record": {
      const rightRecord = right as typeof left;
      if (left.fields.size !== rightRecord.fields.size) {
        return false;
      }

      for (const [key, leftValue] of left.fields) {
        const rightValue = rightRecord.fields.get(key);
        if (!rightValue || !valuesEqual(leftValue, rightValue)) {
          return false;
        }
      }

      return true;
    }
  }
}

function compareValues(
  operator: "<" | "<=" | ">" | ">=",
  left: HarlanValue,
  right: HarlanValue,
  context: RuntimeContext,
  span: SourceSpan,
): HarlanValue {
  if (left.kind === "number" && right.kind === "number") {
    return { kind: "boolean", value: applyComparison(operator, left.value, right.value) };
  }

  if (left.kind === "string" && right.kind === "string") {
    return { kind: "boolean", value: applyComparison(operator, left.value, right.value) };
  }

  throw new RuntimeError(
    "comparison operators require both operands to be numbers or both operands to be strings",
    span,
    context.source,
    { hints: ["Compare values of the same type before using `<`, `<=`, `>`, or `>=`."] },
  );
}

function applyComparison(
  operator: "<" | "<=" | ">" | ">=",
  left: number | string,
  right: number | string,
): boolean {
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
}

function unknownBindingHints(name: string): string[] {
  if (knownModuleNames.has(name)) {
    return [`Import modules before use, for example:\n  let ${name} = import("${name}")`];
  }

  return [
    "Bindings are immutable and must be introduced with `let name = expression` or `fn name(...) = expression` before use.",
  ];
}

function unknownPropertyHints(value: Extract<HarlanValue, { kind: "record" }>): string[] {
  const properties = [...value.fields.keys()];
  if (value.moduleName && properties.length > 0) {
    return [
      `Module \`${value.moduleName}\` provides: ${properties.map((name) => `\`${name}\``).join(", ")}.`,
    ];
  }

  if (properties.length > 0 && properties.length <= 12) {
    return [`Available properties are: ${properties.map((name) => `\`${name}\``).join(", ")}.`];
  }

  return ["Check the field name or return the record itself to inspect its available properties."];
}

function booleanOperandHint(): string {
  return 'Boolean operators require Boolean values; compare strings or numbers first, for example `info.kind == "file" and info.size > 0`.';
}

function pipelineHint(): string {
  return "Pipeline targets must be functions: `value |> module.function(args)`.";
}
