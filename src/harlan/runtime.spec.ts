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
