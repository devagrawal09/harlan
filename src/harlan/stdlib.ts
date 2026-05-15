import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { EOL } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FunctionDeclaration } from "./ast.ts";
import { RuntimeError } from "./errors.ts";
import { harlanValueToJson, renderHarlanValue } from "./render.ts";
import type { HarlanCallable, HarlanValue, RuntimeContext } from "./runtime.ts";
import type { SourceSpan } from "./tokens.ts";

const execFileAsync = promisify(execFile);
const ignoredDirectoryNames = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const searchResultLimit = 200;
const signaturesByName = new Map<string, string>([
  ["fs.cwd", "fs.cwd()"],
  ["fs.read", "fs.read(path: String)"],
  ["fs.list", "fs.list(path: String)"],
  ["fs.exists", "fs.exists(path: String)"],
  ["fs.glob", "fs.glob(pattern: String)"],
  ["fs.search", "fs.search(path: String, query: String)"],
  ["fs.info", "fs.info(path: String)"],
  ["shell.run", "shell.run(command: String)"],
  ["text.lines", "text.lines(value: String)"],
  ["text.join", "text.join(items: List, separator: String)"],
  ["text.take", "text.take(items: List, count: Number)"],
  ["text.contains", "text.contains(value: String, query: String)"],
  ["text.trim", "text.trim(value: String)"],
  ["text.lower", "text.lower(value: String)"],
  ["text.includes", "text.includes(items: List, query: String)"],
  ["format.json", "format.json(value)"],
  ["format.lines", "format.lines(items: List[String])"],
  ["format.table", "format.table(items: List[Record])"],
]);

export type HarlanRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowShell?: boolean;
  maxOutputChars?: number;
  sessionSnapshot?: HarlanSessionSnapshot;
  maxSessionStateChars?: number;
};

export type SerializedHarlanValue =
  | { kind: "null" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "list"; items: SerializedHarlanValue[] }
  | { kind: "record"; fields: Record<string, SerializedHarlanValue> }
  | { kind: "module"; name: string }
  | { kind: "stdlibFunction"; name: string }
  | {
      kind: "function";
      name: string;
      declaration: FunctionDeclaration;
      closure: Record<string, SerializedHarlanValue>;
    };

export type HarlanSessionSnapshot = {
  bindings: Record<string, SerializedHarlanValue>;
  importedModules: string[];
};

export type HarlanBindingSummary = {
  name: string;
  kind: "null" | "string" | "number" | "boolean" | "list" | "record" | "module" | "function";
};

export type HarlanModule = {
  name: string;
  bindings: Map<string, HarlanValue>;
};

export function createStdlib(): Map<string, HarlanModule> {
  const modules = [createFsModule(), createShellModule(), createTextModule(), createFormatModule()];
  return new Map(modules.map((module) => [module.name, module]));
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
          {
            hints: [
              "Use `fs.info(path)` to check whether a path is a file or directory before reading.",
            ],
          },
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
    glob: async (args, context, span) => {
      requireArity("fs.glob", args, 1, context, span);
      const pattern = requireString("fs.glob", args[0]!, context, span);
      assertRelativePath(pattern, context, span);
      const paths = await listFiles(context.options.cwd);
      return listValue(
        paths
          .filter((filePath) => matchesGlob(pattern, filePath))
          .sort()
          .map(stringValue),
      );
    },
    search: async (args, context, span) => {
      requireArity("fs.search", args, 2, context, span);
      const inputPath = requireString("fs.search", args[0]!, context, span);
      const query = requireString("fs.search", args[1]!, context, span);
      const resolved = resolveInsideCwd(inputPath, context, span);
      const targetStat = await stat(resolved).catch((error: unknown) => {
        throw runtimeFromUnknown(`unable to search \`${inputPath}\``, error, context, span);
      });
      const relativePaths = targetStat.isDirectory()
        ? await listFiles(resolved, path.relative(context.options.cwd, resolved))
        : [path.relative(context.options.cwd, resolved)];
      const matches: HarlanValue[] = [];
      let truncated = false;

      for (const relativePath of relativePaths.sort()) {
        if (matches.length >= searchResultLimit) {
          truncated = true;
          break;
        }

        const absolutePath = path.resolve(context.options.cwd, relativePath);
        const content = await readTextFileIfSearchable(absolutePath);
        if (content === null) {
          continue;
        }

        for (const match of searchContent(relativePath, content, query)) {
          if (matches.length >= searchResultLimit) {
            truncated = true;
            break;
          }

          matches.push(recordValue(match));
        }
      }

      return recordValue({
        matches: listValue(matches),
        truncated: booleanValue(truncated),
      });
    },
    info: async (args, context, span) => {
      requireArity("fs.info", args, 1, context, span);
      const inputPath = requireString("fs.info", args[0]!, context, span);
      const resolved = resolveInsideCwd(inputPath, context, span);
      const targetStat = await stat(resolved).catch((error: unknown) => {
        throw runtimeFromUnknown(`unable to inspect \`${inputPath}\``, error, context, span);
      });

      return recordValue({
        path: stringValue(path.relative(context.options.cwd, resolved) || "."),
        kind: stringValue(targetStat.isDirectory() ? "directory" : "file"),
        size: numberValue(targetStat.isDirectory() ? 0 : targetStat.size),
      });
    },
  });
}

function createShellModule(): HarlanModule {
  return moduleFromBindings("shell", {
    run: async (args, context, span) => {
      requireArity("shell.run", args, 1, context, span);

      if (!context.options.allowShell) {
        throw new RuntimeError("shell.run is disabled for this execution", span, context.source, {
          hints: [
            "Prefer `fs`, `text`, and `format` helpers unless shell execution is explicitly enabled.",
          ],
        });
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
    contains: (args, context, span) => {
      requireArity("text.contains", args, 2, context, span);
      return booleanValue(
        requireString("text.contains", args[0]!, context, span).includes(
          requireString("text.contains", args[1]!, context, span),
        ),
      );
    },
    trim: (args, context, span) => {
      requireArity("text.trim", args, 1, context, span);
      return stringValue(requireString("text.trim", args[0]!, context, span).trim());
    },
    lower: (args, context, span) => {
      requireArity("text.lower", args, 1, context, span);
      return stringValue(requireString("text.lower", args[0]!, context, span).toLowerCase());
    },
    includes: (args, context, span) => {
      requireArity("text.includes", args, 2, context, span);
      const query = requireString("text.includes", args[1]!, context, span);
      return booleanValue(
        requireList("text.includes", args[0]!, context, span).some(
          (item) => requireString("text.includes", item, context, span) === query,
        ),
      );
    },
  });
}

function createFormatModule(): HarlanModule {
  return moduleFromBindings("format", {
    json: (args, context, span) => {
      requireArity("format.json", args, 1, context, span);
      return stringValue(JSON.stringify(harlanValueToJson(args[0]!), null, 2));
    },
    lines: (args, context, span) => {
      requireArity("format.lines", args, 1, context, span);
      const lines = requireList("format.lines", args[0]!, context, span).map((item) =>
        requireString("format.lines", item, context, span),
      );
      return stringValue(lines.join("\n"));
    },
    table: (args, context, span) => {
      requireArity("format.table", args, 1, context, span);
      return stringValue(
        formatTable(requireList("format.table", args[0]!, context, span), context, span),
      );
    },
  });
}

function moduleFromBindings(name: string, bindings: Record<string, HarlanCallable>): HarlanModule {
  return {
    name,
    bindings: new Map(
      Object.entries(bindings).map(([bindingName, call]) => [
        bindingName,
        {
          kind: "function",
          name: `${name}.${bindingName}`,
          stdlibName: `${name}.${bindingName}`,
          call,
        },
      ]),
    ),
  };
}

function resolveInsideCwd(inputPath: string, context: RuntimeContext, span: SourceSpan): string {
  const cwd = path.resolve(context.options.cwd);
  const resolved = path.resolve(cwd, inputPath);
  const relative = path.relative(cwd, resolved);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RuntimeError(`path escapes the runtime cwd: \`${inputPath}\``, span, context.source, {
      hints: ["Use paths relative to the runtime cwd and do not include `..` path traversal."],
    });
  }

  return resolved;
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) {
      continue;
    }

    const relativePath = prefix ? path.posix.join(toPosixPath(prefix), entry.name) : entry.name;
    const absolutePath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

function assertRelativePath(inputPath: string, context: RuntimeContext, span: SourceSpan): void {
  if (
    inputPath === ".." ||
    inputPath.startsWith("../") ||
    inputPath.includes("/../") ||
    path.isAbsolute(inputPath)
  ) {
    throw new RuntimeError(`path escapes the runtime cwd: \`${inputPath}\``, span, context.source, {
      hints: ["Use paths relative to the runtime cwd and do not include `..` path traversal."],
    });
  }
}

function matchesGlob(pattern: string, filePath: string): boolean {
  const normalizedPattern = toPosixPath(pattern);
  const normalizedPath = toPosixPath(filePath);

  if (!normalizedPattern.includes("*")) {
    return normalizedPattern === normalizedPath;
  }

  const regex = new RegExp(`^${globToRegexSource(normalizedPattern)}$`);
  return regex.test(normalizedPath);
}

function globToRegexSource(pattern: string): string {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegex(char);
    }
  }

  return source;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function readTextFileIfSearchable(filePath: string): Promise<string | null> {
  const buffer = await readFile(filePath).catch(() => null);
  if (buffer === null || buffer.includes(0)) {
    return null;
  }

  return buffer.toString("utf8");
}

function searchContent(
  filePath: string,
  content: string,
  query: string,
): Array<Record<string, HarlanValue>> {
  if (query === "") {
    return [];
  }

  return content.split(/\r?\n/).flatMap((line, lineIndex) => {
    const matches: Array<Record<string, HarlanValue>> = [];
    let fromIndex = 0;

    while (fromIndex <= line.length) {
      const columnIndex = line.indexOf(query, fromIndex);
      if (columnIndex === -1) {
        break;
      }

      matches.push({
        path: stringValue(toPosixPath(filePath)),
        line: numberValue(lineIndex + 1),
        column: numberValue(columnIndex + 1),
        text: stringValue(line),
      });
      fromIndex = columnIndex + Math.max(1, query.length);
    }

    return matches;
  });
}

function formatTable(items: HarlanValue[], context: RuntimeContext, span: SourceSpan): string {
  const records = items.map((item) => {
    if (item.kind !== "record") {
      throw new RuntimeError("format.table expected a List of records", span, context.source, {
        hints: [
          'Pass records to `format.table`, commonly `fs.search("src", "query").matches |> format.table()`.',
        ],
      });
    }
    return item;
  });

  const keys: string[] = [];
  for (const record of records) {
    for (const key of record.fields.keys()) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }

  if (keys.length === 0) {
    return "";
  }

  const header = `| ${keys.map(escapeMarkdownTableCell).join(" | ")} |`;
  const divider = `| ${keys.map(() => "---").join(" | ")} |`;
  const rows = records.map(
    (record) =>
      `| ${keys
        .map((key) =>
          escapeMarkdownTableCell(renderHarlanValue(record.fields.get(key) ?? { kind: "null" })),
        )
        .join(" | ")} |`,
  );

  return [header, divider, ...rows].join("\n");
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
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
      { hints: hintsForFunction(name) },
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
    throw new RuntimeError(
      `${name} expected a String but received ${formatKind(value)}`,
      span,
      context.source,
      { hints: hintsForFunction(name) },
    );
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
    throw new RuntimeError(
      `${name} expected a Number but received ${formatKind(value)}`,
      span,
      context.source,
      { hints: hintsForFunction(name) },
    );
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
    throw new RuntimeError(
      `${name} expected a List but received ${formatKind(value)}`,
      span,
      context.source,
      { hints: hintsForFunction(name) },
    );
  }

  return value.items;
}

function stringValue(value: string): HarlanValue {
  return { kind: "string", value };
}

function numberValue(value: number): HarlanValue {
  return { kind: "number", value };
}

function booleanValue(value: boolean): HarlanValue {
  return { kind: "boolean", value };
}

function listValue(items: HarlanValue[]): HarlanValue {
  return { kind: "list", items };
}

function recordValue(fields: Record<string, HarlanValue>): HarlanValue {
  return { kind: "record", fields: new Map(Object.entries(fields)) };
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

function hintsForFunction(name: string): string[] {
  const signature = signaturesByName.get(name);
  const hints = signature ? [`Expected call shape: \`${signature}\`.`] : [];

  if (name === "fs.search") {
    hints.push(
      'For bounded results, use `let { matches, truncated } = fs.search("src", "query")`.',
    );
  }

  return hints;
}

function formatKind(value: HarlanValue): string {
  switch (value.kind) {
    case "null":
      return "Null";
    case "string":
      return "String";
    case "number":
      return "Number";
    case "boolean":
      return "Boolean";
    case "list":
      return "List";
    case "record":
      return "Record";
    case "function":
      return "Function";
  }
}
