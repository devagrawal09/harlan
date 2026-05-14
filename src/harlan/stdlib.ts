import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { EOL } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RuntimeError } from "./errors.ts";
import type { HarlanCallable, HarlanValue, RuntimeContext } from "./runtime.ts";
import type { SourceSpan } from "./tokens.ts";

const execFileAsync = promisify(execFile);

export type HarlanRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowShell?: boolean;
};

export type HarlanModule = {
  name: string;
  bindings: Map<string, HarlanValue>;
};

export function createStdlib(): Map<string, HarlanModule> {
  const modules = [createFsModule(), createShellModule(), createTextModule()];
  return new Map(modules.map((module) => [module.name, module]));
}

export function renderHarlanValue(value: HarlanValue): string {
  switch (value.kind) {
    case "null":
      return "null";
    case "string":
      return value.value;
    case "number":
      return String(value.value);
    case "boolean":
      return String(value.value);
    case "list":
      return `[${value.items.map(renderHarlanValueForCollection).join(", ")}]`;
    case "record":
      return `{ ${[...value.fields.entries()]
        .map(([key, fieldValue]) => `${key}: ${renderHarlanValueForCollection(fieldValue)}`)
        .join(", ")} }`;
    case "function":
      return `<function${value.name ? ` ${value.name}` : ""}>`;
  }
}

function renderHarlanValueForCollection(value: HarlanValue): string {
  if (value.kind === "string") {
    return JSON.stringify(value.value);
  }

  return renderHarlanValue(value);
}

function createFsModule(): HarlanModule {
  return moduleFromBindings("fs", {
    cwd: (_args, context) => stringValue(context.options.cwd),
    read: async (args, context, span) => {
      requireArity("fs.read", args, 1, context, span);
      const filePath = requireString("fs.read", args[0]!, context, span);
      const resolved = resolveInsideCwd(filePath, context, span);
      const fileStat = await stat(resolved).catch((error: unknown) => {
        throw runtimeFromUnknown(`unable to read \`${filePath}\``, error, context, span);
      });

      if (!fileStat.isFile()) {
        throw new RuntimeError(
          `fs.read expected a file path: \`${filePath}\``,
          span,
          context.source,
        );
      }

      return stringValue(await readFile(resolved, "utf8"));
    },
    list: async (args, context, span) => {
      requireArity("fs.list", args, 1, context, span);
      const dirPath = requireString("fs.list", args[0]!, context, span);
      const resolved = resolveInsideCwd(dirPath, context, span);
      const entries = await readdir(resolved).catch((error: unknown) => {
        throw runtimeFromUnknown(`unable to list \`${dirPath}\``, error, context, span);
      });

      return listValue(entries.map(stringValue));
    },
    exists: async (args, context, span) => {
      requireArity("fs.exists", args, 1, context, span);
      const targetPath = requireString("fs.exists", args[0]!, context, span);
      const resolved = resolveInsideCwd(targetPath, context, span);
      await access(resolved).catch(() => false);
      try {
        await access(resolved);
        return booleanValue(true);
      } catch {
        return booleanValue(false);
      }
    },
  });
}

function createShellModule(): HarlanModule {
  return moduleFromBindings("shell", {
    run: async (args, context, span) => {
      requireArity("shell.run", args, 1, context, span);

      if (!context.options.allowShell) {
        throw new RuntimeError("shell.run is disabled for this execution", span, context.source);
      }

      const command = requireString("shell.run", args[0]!, context, span);

      try {
        const { stdout } = await execFileAsync("sh", ["-c", command], {
          cwd: context.options.cwd,
          env: context.options.env,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        return stringValue(stdout.trimEnd());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RuntimeError(`shell.run failed: ${message}`, span, context.source);
      }
    },
  });
}

function createTextModule(): HarlanModule {
  return moduleFromBindings("text", {
    lines: (args, context, span) => {
      requireArity("text.lines", args, 1, context, span);
      return listValue(
        requireString("text.lines", args[0]!, context, span).split(/\r?\n/).map(stringValue),
      );
    },
    join: (args, context, span) => {
      requireArity("text.join", args, 2, context, span);
      const items = requireList("text.join", args[0]!, context, span).map((item) =>
        requireString("text.join", item, context, span),
      );
      const separator = requireString("text.join", args[1]!, context, span);
      return stringValue(items.join(separator));
    },
    take: (args, context, span) => {
      requireArity("text.take", args, 2, context, span);
      const items = requireList("text.take", args[0]!, context, span);
      const count = requireNumber("text.take", args[1]!, context, span);
      return listValue(items.slice(0, count));
    },
  });
}

function moduleFromBindings(name: string, bindings: Record<string, HarlanCallable>): HarlanModule {
  return {
    name,
    bindings: new Map(
      Object.entries(bindings).map(([bindingName, call]) => [
        bindingName,
        { kind: "function", name: `${name}.${bindingName}`, call },
      ]),
    ),
  };
}

function resolveInsideCwd(inputPath: string, context: RuntimeContext, span: SourceSpan): string {
  const cwd = path.resolve(context.options.cwd);
  const resolved = path.resolve(cwd, inputPath);
  const relative = path.relative(cwd, resolved);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RuntimeError(`path escapes the runtime cwd: \`${inputPath}\``, span, context.source);
  }

  return resolved;
}

function requireArity(
  name: string,
  args: HarlanValue[],
  expected: number,
  context: RuntimeContext,
  span: SourceSpan,
): void {
  if (args.length !== expected) {
    throw new RuntimeError(
      `${name} expected ${expected} arguments but received ${args.length}`,
      span,
      context.source,
    );
  }
}

function requireString(
  name: string,
  value: HarlanValue,
  context: RuntimeContext,
  span: SourceSpan,
): string {
  if (value.kind !== "string") {
    throw new RuntimeError(`${name} expected a String`, span, context.source);
  }

  return value.value;
}

function requireNumber(
  name: string,
  value: HarlanValue,
  context: RuntimeContext,
  span: SourceSpan,
): number {
  if (value.kind !== "number") {
    throw new RuntimeError(`${name} expected a Number`, span, context.source);
  }

  return value.value;
}

function requireList(
  name: string,
  value: HarlanValue,
  context: RuntimeContext,
  span: SourceSpan,
): HarlanValue[] {
  if (value.kind !== "list") {
    throw new RuntimeError(`${name} expected a List`, span, context.source);
  }

  return value.items;
}

function stringValue(value: string): HarlanValue {
  return { kind: "string", value };
}

function booleanValue(value: boolean): HarlanValue {
  return { kind: "boolean", value };
}

function listValue(items: HarlanValue[]): HarlanValue {
  return { kind: "list", items };
}

function runtimeFromUnknown(
  message: string,
  error: unknown,
  context: RuntimeContext,
  span: SourceSpan,
): RuntimeError {
  const detail = error instanceof Error ? error.message : String(error);
  return new RuntimeError(`${message}: ${detail || EOL}`, span, context.source);
}
