import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ImportError,
  ParseError,
  RuntimeError,
  parseHarlan,
  renderHarlanResult,
  renderHarlanValue,
  runHarlan,
} from "./index.ts";

test("parses import calls, bindings, functions, collections, calls, members, and pipelines", () => {
  const program = parseHarlan(`
    let fs = import("fs")
    let text = import("text")

    let task = { path: "README.md", limit: 3 }
    let names = ["README.md", "package.json"]

    fn read_task(path: String) -> String =
      fs.read(path)

    read_task(task.path)
      |> text.lines()
  `);

  assert.equal(program.kind, "Program");
  assert.equal(program.statements.length, 6);
  assert.equal(program.statements[0]?.kind, "LetDeclaration");
  assert.equal(program.statements[2]?.kind, "LetDeclaration");
  assert.equal(program.statements[4]?.kind, "FunctionDeclaration");
  assert.equal(program.statements[5]?.kind, "ExpressionStatement");
});

test("rejects invalid syntax with source diagnostics", () => {
  assert.throws(() => parseHarlan("let = nope"), ParseError);
});

test("evaluates import calls, user functions, records, and pipelines", async () => {
  const result = await runHarlan(
    `
      let text = import("text")

      let task = { body: "a\\nb\\nc", limit: 2 }

      fn first_lines(body: String, limit: Number) -> List[String] =
        text.lines(body) |> text.take(limit)

      first_lines(task.body, task.limit)
    `,
    { cwd: process.cwd() },
  );

  assert.equal(result.value.kind, "list");
  assert.deepEqual(
    result.value.items.map((item) => (item.kind === "string" ? item.value : null)),
    ["a", "b"],
  );
});

test("evaluates direct stdlib module calls", async () => {
  const result = await runHarlan(
    `
      let text = import("text")
      text.join(["a", "b"], ",")
    `,
    { cwd: process.cwd() },
  );

  assert.equal(renderHarlanValue(result.value), "a,b");
});

test("rejects duplicate immutable bindings", async () => {
  await assert.rejects(
    () =>
      runHarlan(`
        let value = "a"
        let value = "b"
        value
      `),
    RuntimeError,
  );
});

test("filesystem tools read, list, cwd, and exists inside runtime cwd", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "harlan-"));
  await writeFile(path.join(cwd, "README.md"), "# Harlan\n\nhello\n", "utf8");

  const result = await runHarlan(
    `
      let fs = import("fs")
      let text = import("text")

      let here = fs.cwd()
      let files = fs.list(".")
      let present = fs.exists("README.md")

      fs.read("README.md") |> text.lines() |> text.take(1)
    `,
    { cwd },
  );

  assert.equal(result.value.kind, "list");
  assert.equal(result.value.items[0]?.kind, "string");
  assert.equal(
    result.value.items[0]?.kind === "string" ? result.value.items[0].value : "",
    "# Harlan",
  );
});

test("filesystem tools reject missing files and path traversal", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "harlan-"));

  await assert.rejects(
    () =>
      runHarlan(
        `
          let fs = import("fs")
          fs.read("missing.txt")
        `,
        { cwd },
      ),
    RuntimeError,
  );

  await assert.rejects(
    () =>
      runHarlan(
        `
          let fs = import("fs")
          fs.read("../outside.txt")
        `,
        { cwd },
      ),
    RuntimeError,
  );
});

test("shell.run executes only when enabled", async () => {
  const enabled = await runHarlan(
    `
      let shell = import("shell")
      shell.run("printf hello")
    `,
    { allowShell: true },
  );

  assert.equal(renderHarlanValue(enabled.value), "hello");

  await assert.rejects(
    () =>
      runHarlan(
        `
          let shell = import("shell")
          shell.run("printf hello")
        `,
        { allowShell: false },
      ),
    RuntimeError,
  );
});

test("shell.run reports non-zero command errors", async () => {
  await assert.rejects(
    () =>
      runHarlan(
        `
          let shell = import("shell")
          shell.run("exit 7")
        `,
        { allowShell: true },
      ),
    RuntimeError,
  );
});

test("unknown modules and properties fail clearly", async () => {
  await assert.rejects(() => runHarlan('import("missing")'), ImportError);
  await assert.rejects(
    () =>
      runHarlan(`
        let fs = import("fs")
        fs.remove("README.md")
      `),
    RuntimeError,
  );
});

test("acceptance example returns first README lines", async () => {
  const result = await runHarlan(
    `
      let fs = import("fs")
      let text = import("text")

      fs.read("README.md")
        |> text.lines()
        |> text.take(3)
    `,
    { cwd: process.cwd() },
  );

  assert.equal(result.value.kind, "list");
  assert.equal(result.value.items.length, 3);
});

test("fs.glob discovers sorted files and rejects escaping cwd", async () => {
  const markdown = await runHarlan(
    `
      let fs = import("fs")
      fs.glob("*.md")
    `,
    { cwd: process.cwd() },
  );
  assert.equal(markdown.value.kind, "list");
  assert.ok(
    markdown.value.items.some((item) => item.kind === "string" && item.value === "README.md"),
  );

  const source = await runHarlan(
    `
      let fs = import("fs")
      fs.glob("src/**/*.ts")
    `,
    { cwd: process.cwd() },
  );
  assert.equal(source.value.kind, "list");
  const paths = source.value.items.map((item) => (item.kind === "string" ? item.value : ""));
  assert.ok(paths.includes("src/harlan/runtime.ts"));
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(!paths.some((item) => item.includes("node_modules")));

  await assert.rejects(
    () =>
      runHarlan(
        `
          let fs = import("fs")
          fs.glob("../*.ts")
        `,
        { cwd: process.cwd() },
      ),
    RuntimeError,
  );
});

test("fs.search returns structured matches for directories and files", async () => {
  const directory = await runHarlan(
    `
      let fs = import("fs")
      fs.search("src", "execute_harlan")
    `,
    { cwd: process.cwd() },
  );

  assert.equal(directory.value.kind, "record");
  const matches = directory.value.fields.get("matches");
  const truncated = directory.value.fields.get("truncated");
  assert.equal(matches?.kind, "list");
  assert.equal(truncated?.kind, "boolean");
  assert.ok(matches?.kind === "list" && matches.items.length > 0);

  const first = matches?.kind === "list" ? matches.items[0] : null;
  assert.equal(first?.kind, "record");
  assert.equal(first?.kind === "record" ? first.fields.get("path")?.kind : null, "string");
  assert.equal(first?.kind === "record" ? first.fields.get("line")?.kind : null, "number");
  assert.equal(first?.kind === "record" ? first.fields.get("column")?.kind : null, "number");
  assert.equal(first?.kind === "record" ? first.fields.get("text")?.kind : null, "string");

  const file = await runHarlan(
    `
      let fs = import("fs")
      fs.search("src/cli.ts", "execute_harlan")
    `,
    { cwd: process.cwd() },
  );
  assert.equal(file.value.kind, "record");
  assert.equal(file.value.fields.get("matches")?.kind, "list");

  await assert.rejects(
    () =>
      runHarlan(
        `
          let fs = import("fs")
          fs.search("missing", "x")
        `,
        { cwd: process.cwd() },
      ),
    RuntimeError,
  );
  await assert.rejects(
    () =>
      runHarlan(
        `
          let fs = import("fs")
          fs.search("../", "x")
        `,
        { cwd: process.cwd() },
      ),
    RuntimeError,
  );
});

test("fs.info returns file and directory metadata", async () => {
  const file = await runHarlan(
    `
      let fs = import("fs")
      fs.info("README.md")
    `,
    { cwd: process.cwd() },
  );
  assert.equal(file.value.kind, "record");
  const fileKind = file.value.fields.get("kind");
  const fileSize = file.value.fields.get("size");
  assert.equal(fileKind?.kind, "string");
  assert.equal(fileKind.kind === "string" ? fileKind.value : "", "file");
  assert.equal(fileSize?.kind, "number");
  assert.ok(fileSize.kind === "number" && fileSize.value > 0);

  const directory = await runHarlan(
    `
      let fs = import("fs")
      fs.info("src")
    `,
    { cwd: process.cwd() },
  );
  assert.equal(directory.value.kind, "record");
  const directoryKind = directory.value.fields.get("kind");
  assert.equal(directoryKind?.kind, "string");
  assert.equal(directoryKind.kind === "string" ? directoryKind.value : "", "directory");
});

test("text helpers support common string and list checks", async () => {
  const result = await runHarlan(
    `
      let text = import("text")
      {
        contains: text.contains("abc", "b"),
        trim: text.trim("  abc  "),
        lower: text.lower("ABC"),
        includes: text.includes(["a", "b"], "b")
      }
    `,
    { cwd: process.cwd() },
  );

  assert.equal(result.value.kind, "record");
  const contains = result.value.fields.get("contains");
  const trim = result.value.fields.get("trim");
  const lower = result.value.fields.get("lower");
  const includes = result.value.fields.get("includes");
  assert.equal(contains?.kind === "boolean" && contains.value, true);
  assert.equal(trim?.kind === "string" ? trim.value : "", "abc");
  assert.equal(lower?.kind === "string" ? lower.value : "", "abc");
  assert.equal(includes?.kind === "boolean" && includes.value, true);
});

test("format helpers produce json, lines, and markdown tables", async () => {
  const json = await runHarlan(
    `
      let format = import("format")
      format.json({ path: "README.md", count: 3 })
    `,
    { cwd: process.cwd() },
  );
  assert.equal(json.value.kind, "string");
  assert.ok(json.value.kind === "string" && json.value.value.includes('"path"'));
  assert.ok(json.value.kind === "string" && json.value.value.includes('"count"'));

  const lines = await runHarlan(
    `
      let format = import("format")
      format.lines(["a", "b"])
    `,
    { cwd: process.cwd() },
  );
  assert.equal(renderHarlanValue(lines.value), "a\nb");

  const table = await runHarlan(
    `
      let format = import("format")
      format.table([{ path: "a", line: 1 }])
    `,
    { cwd: process.cwd() },
  );
  assert.equal(table.value.kind, "string");
  assert.ok(table.value.kind === "string" && table.value.value.includes("| path | line |"));
});

test("renderHarlanResult includes output, value, and truncation", () => {
  const rendered = renderHarlanResult({
    output: ["side effect"],
    value: { kind: "string", value: "final value" },
  });
  assert.equal(rendered, "side effect\nfinal value");

  const truncated = renderHarlanResult(
    {
      output: [],
      value: { kind: "string", value: "abcdefghij" },
    },
    { maxChars: 4 },
  );
  assert.equal(truncated, "abcd\n... truncated after 4 characters");
});

test("agent usefulness acceptance examples work", async () => {
  const search = await runHarlan(
    `
      let fs = import("fs")
      let format = import("format")

      fs.search("src", "execute_harlan").matches
        |> format.table()
    `,
    { cwd: process.cwd() },
  );
  assert.equal(search.value.kind, "string");
  assert.ok(search.value.kind === "string" && search.value.value.includes("src/cli.ts"));

  const glob = await runHarlan(
    `
      let fs = import("fs")
      let format = import("format")

      fs.glob("src/**/*.ts")
        |> format.lines()
    `,
    { cwd: process.cwd() },
  );
  assert.equal(glob.value.kind, "string");
  assert.ok(glob.value.kind === "string" && glob.value.value.includes("src/harlan/runtime.ts"));
});
