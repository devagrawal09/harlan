import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  ImportError,
  ParseError,
  RuntimeError,
  formatUnknownError,
  getHarlanRunState,
  type HarlanValue,
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

test("formats parse errors with concise guidance", () => {
  const formatted = formatThrownError(() => parseHarlan("let = nope"));

  assert.match(formatted, /ParseError/);
  assert.match(formatted, /\^/);
  assert.match(formatted, /Hint:/);
  assert.match(formatted, /let name = expression/);
});

test("formats lexer errors with concise guidance", () => {
  const semicolon = formatThrownError(() => parseHarlan('let x = "a";'));
  assert.match(semicolon, /unexpected character `;`/);
  assert.match(semicolon, /do not use semicolons/);

  const singleQuote = formatThrownError(() => parseHarlan("let x = 'a'"));
  assert.match(singleQuote, /unexpected character `'`/);
  assert.match(singleQuote, /Strings use double quotes/);
});

test("formats runtime errors with concise guidance", async () => {
  const missingImport = await formatRejectedError(() => runHarlan('fs.read("README.md")'));
  assert.match(missingImport, /unknown binding `fs`/);
  assert.match(missingImport, /let fs = import\("fs"\)/);

  const unknownProperty = await formatRejectedError(() =>
    runHarlan(`
      let fs = import("fs")
      fs.remove("README.md")
    `),
  );
  assert.match(unknownProperty, /unknown property `remove`/);
  assert.match(unknownProperty, /`read`/);
  assert.match(unknownProperty, /`search`/);
  assert.match(unknownProperty, /`glob`/);

  const typeMismatch = await formatRejectedError(() =>
    runHarlan(`
      let fs = import("fs")
      fs.read(123)
    `),
  );
  assert.match(typeMismatch, /expected a String/);
  assert.match(typeMismatch, /received Number/);
  assert.match(typeMismatch, /fs\.read\(path: String\)/);

  const pipeline = await formatRejectedError(() => runHarlan('["a", "b"] |> 1'));
  assert.match(pipeline, /pipeline target is not a function/);
  assert.match(pipeline, /value \|> module\.function\(args\)/);
});

test("formats errors without hints exactly as before", () => {
  assert.equal(new RuntimeError("plain").format(), "RuntimeError: plain");
});

test("parses script logic expressions and destructuring patterns", () => {
  const conditional = parseHarlan('if true then "a" else "b"');
  assert.equal(conditional.statements[0]?.kind, "ExpressionStatement");
  assert.equal(
    conditional.statements[0]?.kind === "ExpressionStatement"
      ? conditional.statements[0].expression.kind
      : "",
    "IfExpression",
  );

  const operators = parseHarlan("not false or 1 == 1 and 2 <= 3");
  assert.equal(operators.statements[0]?.kind, "ExpressionStatement");
  assert.equal(
    operators.statements[0]?.kind === "ExpressionStatement"
      ? operators.statements[0].expression.kind
      : "",
    "BinaryExpression",
  );

  const destructuring = parseHarlan(`
    let { matches, nested: { inner } } = result
    let [first, second] = matches
  `);
  assert.equal(destructuring.statements[0]?.kind, "LetDeclaration");
  assert.equal(
    destructuring.statements[0]?.kind === "LetDeclaration"
      ? destructuring.statements[0].pattern.kind
      : "",
    "RecordPattern",
  );
  assert.equal(
    destructuring.statements[1]?.kind === "LetDeclaration"
      ? destructuring.statements[1].pattern.kind
      : "",
    "ListPattern",
  );
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

test("fs glob and search respect gitignore rules", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "harlan-runtime-"));
  await writeFile(path.join(cwd, ".gitignore"), "ignored/\n.repos\n*.log\n!.keep.log\n");
  await writeFile(path.join(cwd, "visible.ts"), "needle\n");
  await writeFile(path.join(cwd, "debug.log"), "needle\n");
  await writeFile(path.join(cwd, ".keep.log"), "needle\n");
  await mkdir(path.join(cwd, "ignored"));
  await writeFile(path.join(cwd, "ignored", "hidden.ts"), "needle\n");
  await mkdir(path.join(cwd, ".repos"));
  await writeFile(path.join(cwd, ".repos", "nested.ts"), "needle\n");
  await mkdir(path.join(cwd, ".git"));
  await writeFile(path.join(cwd, ".git", "config"), "needle\n");

  const glob = await runHarlan(
    `
      let fs = import("fs")
      fs.glob("**/*")
    `,
    { cwd },
  );
  assert.equal(
    renderHarlanValue(glob.value),
    '[".gitignore", ".keep.log", "visible.ts"]',
  );

  const search = await runHarlan(
    `
      let fs = import("fs")
      let format = import("format")
      fs.search(".", "needle").matches
        |> format.table()
    `,
    { cwd },
  );
  assert.match(renderHarlanValue(search.value), /visible\.ts/);
  assert.match(renderHarlanValue(search.value), /\.keep\.log/);
  assert.doesNotMatch(renderHarlanValue(search.value), /ignored/);
  assert.doesNotMatch(renderHarlanValue(search.value), /\.repos/);
  assert.doesNotMatch(renderHarlanValue(search.value), /\.git/);
  assert.doesNotMatch(renderHarlanValue(search.value), /debug\.log/);
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

test("evaluates conditionals without evaluating the unused branch", async () => {
  const thenResult = await runHarlan('if true then "yes" else missing.name');
  assert.equal(renderHarlanValue(thenResult.value), "yes");

  const elseResult = await runHarlan('if false then missing.name else "no"');
  assert.equal(renderHarlanValue(elseResult.value), "no");

  await assert.rejects(() => runHarlan('if "x" then "yes" else "no"'), RuntimeError);
});

test("evaluates equality, comparison, boolean operators, and null", async () => {
  const equality = await runHarlan(`
    {
      sameString: "a" == "a",
      diffString: "a" != "b",
      sameList: [1, 2] == [1, 2],
      sameRecord: { a: 1 } == { a: 1 },
      nullEqual: null == null
    }
  `);
  assertRecordBooleans(equality.value, [
    "sameString",
    "diffString",
    "sameList",
    "sameRecord",
    "nullEqual",
  ]);

  const comparison = await runHarlan(`
    {
      lt: 1 < 2,
      lte: 2 <= 2,
      gt: "b" > "a",
      gte: "b" >= "b"
    }
  `);
  assertRecordBooleans(comparison.value, ["lt", "lte", "gt", "gte"]);

  assert.equal(renderHarlanValue((await runHarlan("false and missing.name")).value), "false");
  assert.equal(renderHarlanValue((await runHarlan("true or missing.name")).value), "true");
  assert.equal(renderHarlanValue((await runHarlan("not false")).value), "true");

  await assert.rejects(() => runHarlan('1 < "2"'), RuntimeError);
  await assert.rejects(() => runHarlan('"yes" and true'), RuntimeError);
  await assert.rejects(() => runHarlan('not "yes"'), RuntimeError);
});

test("evaluates record, list, alias, missing, and nested destructuring", async () => {
  const record = await runHarlan(`
    let result = { matches: ["a"], truncated: false }
    let { matches, truncated } = result
    matches
  `);
  assert.equal(renderHarlanValue(record.value), '["a"]');

  const alias = await runHarlan(`
    let result = { matches: ["a"] }
    let { matches: found } = result
    found
  `);
  assert.equal(renderHarlanValue(alias.value), '["a"]');

  const missingField = await runHarlan(`
    let { missing } = {}
    missing
  `);
  assert.equal(renderHarlanValue(missingField.value), "null");

  const list = await runHarlan(`
    let [first, second, third] = ["a", "b"]
    third
  `);
  assert.equal(renderHarlanValue(list.value), "null");

  const nested = await runHarlan(`
    let { outer: { inner } } = { outer: { inner: "value" } }
    inner
  `);
  assert.equal(renderHarlanValue(nested.value), "value");

  await assert.rejects(
    () =>
      runHarlan(`
        let { a, b: a } = { a: 1, b: 2 }
        a
      `),
    RuntimeError,
  );

  await assert.rejects(
    () =>
      runHarlan(`
        let existing = "keep"
        let { a: existing } = { a: "replace" }
        existing
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
      fs.search("src/agent.ts", "execute_harlan")
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
    sessionSnapshot: { bindings: {}, importedModules: [] },
    warnings: [],
  });
  assert.equal(rendered, "side effect\nfinal value");

  const truncated = renderHarlanResult(
    {
      output: [],
      value: { kind: "string", value: "abcdefghij" },
      sessionSnapshot: { bindings: {}, importedModules: [] },
      warnings: [],
    },
    { maxChars: 4 },
  );
  assert.equal(truncated, "abcd\n... truncated after 4 characters");

  const revealed = renderHarlanResult({
    output: [],
    warnings: ["Revealed x.y:\n- f()\n\nfn f() = 1"],
    value: { kind: "null" },
    sessionSnapshot: { bindings: {}, importedModules: [] },
    suppressNullValue: true,
  });
  assert.match(revealed, /Revealed x\.y:/);
  assert.match(revealed, /fn f\(\) = 1/);
  assert.doesNotMatch(revealed, /\nnull$/);

  assert.equal(
    renderHarlanResult({
      output: [],
      warnings: [],
      value: { kind: "null" },
      sessionSnapshot: { bindings: {}, importedModules: [] },
    }),
    "null",
  );
});

test("persists imported modules across run snapshots", async () => {
  const first = await runHarlan('let fs = import("fs")', { cwd: process.cwd() });
  const second = await runHarlan("fs.cwd()", {
    cwd: process.cwd(),
    sessionSnapshot: first.sessionSnapshot,
  });

  assert.equal(renderHarlanValue(second.value), process.cwd());
  assert.deepEqual(second.sessionSnapshot.importedModules, ["fs"]);
});

test("persists top-level values across run snapshots", async () => {
  const first = await runHarlan('let answer = "forty two"');
  const second = await runHarlan("answer", { sessionSnapshot: first.sessionSnapshot });

  assert.equal(renderHarlanValue(second.value), "forty two");
});

test("persists top-level functions with frozen closures", async () => {
  const first = await runHarlan(`
    let prefix = "hello"
    fn greet(name: String) = prefix
  `);
  const second = await runHarlan('greet("world")', { sessionSnapshot: first.sessionSnapshot });

  assert.equal(renderHarlanValue(second.value), "hello");
});

test("persists stdlib function aliases", async () => {
  const first = await runHarlan(`
    let fs = import("fs")
    let cwd = fs.cwd
  `);
  const second = await runHarlan("cwd()", {
    cwd: process.cwd(),
    sessionSnapshot: first.sessionSnapshot,
  });

  assert.equal(renderHarlanValue(second.value), process.cwd());
});

test("warns for duplicate same-module imports but rejects normal duplicates", async () => {
  const first = await runHarlan('let fs = import("fs")');
  const duplicateImport = await runHarlan('let fs = import("fs")', {
    sessionSnapshot: first.sessionSnapshot,
  });

  assert.deepEqual(duplicateImport.warnings, [
    "Warning: fs is already imported in this session; use fs directly in later scripts.",
  ]);

  await assert.rejects(
    () => runHarlan("let fs = 1", { sessionSnapshot: first.sessionSnapshot }),
    RuntimeError,
  );
});

test("returns partial snapshot for completed statements before runtime failure", async () => {
  const error = await captureRejectedError(() =>
    runHarlan(`
      let keep = "committed"
      missing.name
    `),
  );
  const runState = getHarlanRunState(error);

  assert.ok(runState);
  const resumed = await runHarlan("keep", { sessionSnapshot: runState.sessionSnapshot });
  assert.equal(renderHarlanValue(resumed.value), "committed");
});

test("state size limit fails oversized binding while keeping earlier commits", async () => {
  const error = await captureRejectedError(() =>
    runHarlan(
      `
        let keep = "committed"
        let too_large = "abcdefghijklmnopqrstuvwxyz"
      `,
      { maxSessionStateChars: 120 },
    ),
  );
  const runState = getHarlanRunState(error);

  assert.ok(runState);
  assert.deepEqual(Object.keys(runState.sessionSnapshot.bindings), ["keep"]);

  const resumed = await runHarlan("keep", { sessionSnapshot: runState.sessionSnapshot });
  assert.equal(renderHarlanValue(resumed.value), "committed");
});

test("agent usefulness acceptance examples work", async () => {
  const search = await runHarlan(
    `
      let fs = import("fs")
      let format = import("format")

      let { matches, truncated } = fs.search("src", "execute_harlan")

      if truncated then
        "too many results"
      else
        format.table(matches)
    `,
    { cwd: process.cwd() },
  );
  assert.equal(search.value.kind, "string");
  assert.ok(search.value.kind === "string" && search.value.value.includes("src/agent.ts"));

  const existence = await runHarlan(
    `
      let fs = import("fs")

      if fs.exists("README.md") and fs.info("README.md").size > 0 then
        "ready"
      else
        "missing"
    `,
    { cwd: process.cwd() },
  );
  assert.equal(renderHarlanValue(existence.value), "ready");

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

test("imports user libraries into persistent namespaces with signatures hidden from bodies", async () => {
  const cwd = await createLibraryWorkspace({
    "mymodule/hello.harlan": `
      let secret = "private"

      fn greet(name: String) -> String =
        name
    `,
  });

  const imported = await runHarlan('import("mymodule.hello")', { cwd });
  assert.match(renderHarlanResult(imported), /Imported mymodule\.hello:/);
  assert.match(renderHarlanResult(imported), /greet\(name: String\) -> String/);
  assert.doesNotMatch(renderHarlanResult(imported), /private/);

  const called = await runHarlan('mymodule.hello.greet("Ada")', {
    cwd,
    sessionSnapshot: imported.sessionSnapshot,
  });
  assert.equal(renderHarlanValue(called.value), "Ada");

  const revealed = await runHarlan("revealImpl(mymodule.hello.greet)", {
    cwd,
    sessionSnapshot: imported.sessionSnapshot,
  });
  assert.equal(renderHarlanValue(revealed.value), "null");
  assert.equal(revealed.suppressNullValue, true);
  assert.match(renderHarlanResult(revealed), /Revealed mymodule\.hello:/);
  assert.match(renderHarlanResult(revealed), /- greet\(name: String\) -> String/);
  assert.match(renderHarlanResult(revealed), /fn greet\(name: String\) -> String =/);
  assert.match(renderHarlanResult(revealed), /name/);
  assert.doesNotMatch(renderHarlanResult(revealed), /\nnull$/);

  const privateLet = await formatRejectedError(() =>
    runHarlan("mymodule.hello.secret", { cwd, sessionSnapshot: imported.sessionSnapshot }),
  );
  assert.match(privateLet, /unknown property `secret`/);
});

test("revealImpl rejects stdlib and normal session functions", async () => {
  const stdlib = await formatRejectedError(() =>
    runHarlan(`
      let fs = import("fs")
      revealImpl(fs.read)
    `),
  );
  assert.match(stdlib, /user-library function/);

  const normal = await formatRejectedError(() =>
    runHarlan(`
      fn local() = "x"
      revealImpl(local)
    `),
  );
  assert.match(normal, /user-library function/);
});

test("user libraries cannot call revealImpl", async () => {
  const cwd = await createLibraryWorkspace({
    "mymodule/bad.harlan": `
      let bad = revealImpl(mymodule.bad.bad)

      fn value() =
        "unused"
    `,
  });

  const error = await formatRejectedError(() => runHarlan('import("mymodule.bad")', { cwd }));
  assert.match(error, /unknown binding `revealImpl`/);
});

test("user libraries can import stdlib modules and other user libraries", async () => {
  const cwd = await createLibraryWorkspace({
    "base/value.harlan": `
      fn value() -> String =
        "ok"
    `,
    "repo/search.harlan": `
      let text = import("text")
      import("base.value")

      fn trimmed() -> String =
        text.trim("  ok  ")

      fn nested() -> String =
        base.value.value()
    `,
  });

  const imported = await runHarlan('import("repo.search")', { cwd });
  assert.match(imported.warnings.join("\n"), /Imported repo\.search/);
  assert.doesNotMatch(imported.warnings.join("\n"), /Imported base\.value/);

  const trimmed = await runHarlan("repo.search.trimmed()", {
    cwd,
    sessionSnapshot: imported.sessionSnapshot,
  });
  const nested = await runHarlan("repo.search.nested()", {
    cwd,
    sessionSnapshot: imported.sessionSnapshot,
  });

  assert.equal(renderHarlanValue(trimmed.value), "ok");
  assert.equal(renderHarlanValue(nested.value), "ok");
});

test("private library imports do not leak disclosures when outer import fails", async () => {
  const cwd = await createLibraryWorkspace({
    "base/value.harlan": `
      fn value() -> String =
        "ok"
    `,
    "repo/bad.harlan": `
      import("base.value")
      missing.binding
    `,
  });

  const error = await captureRejectedError(() => runHarlan('import("repo.bad")', { cwd }));
  const runState = getHarlanRunState(error);

  assert.ok(runState);
  assert.doesNotMatch(runState.warnings.join("\n"), /Imported base\.value/);
  assert.deepEqual(runState.sessionSnapshot.importedModules, []);
});

test("user library import rejects circular imports and invalid specifiers", async () => {
  const cwd = await createLibraryWorkspace({
    "cycle/a.harlan": 'import("cycle.b")',
    "cycle/b.harlan": 'import("cycle.a")',
  });

  const circular = await formatRejectedError(() => runHarlan('import("cycle.a")', { cwd }));
  assert.match(circular, /circular library import/);

  const slash = await formatRejectedError(() => runHarlan('import("mymodule/hello")', { cwd }));
  assert.match(slash, /dot imports/);

  const traversal = await formatRejectedError(() => runHarlan('import("mymodule..hello")', { cwd }));
  assert.match(traversal, /invalid user library import specifier/);

  const hyphenated = await formatRejectedError(() => runHarlan('import("my-module.hello")', { cwd }));
  assert.match(hyphenated, /invalid user library import specifier/);
});

test("user library imports detect namespace collisions and duplicate imports", async () => {
  const cwd = await createLibraryWorkspace({
    "mymodule/hello.harlan": `
      fn greet() -> String =
        "hello"
    `,
  });

  const collision = await formatRejectedError(() =>
    runHarlan(
      `
        let mymodule = 1
        import("mymodule.hello")
      `,
      { cwd },
    ),
  );
  assert.match(collision, /already exists and is immutable/);

  const first = await runHarlan('import("mymodule.hello")', { cwd });
  const duplicate = await runHarlan('import("mymodule.hello")', {
    cwd,
    sessionSnapshot: first.sessionSnapshot,
  });
  assert.match(duplicate.warnings.join("\n"), /already imported/);
});

test("library module records cannot be reused as intermediate namespaces", async () => {
  const cwd = await createLibraryWorkspace({
    "a/b.harlan": `
      fn value() -> String =
        "b"
    `,
    "a/b/c.harlan": `
      fn value() -> String =
        "c"
    `,
  });

  const first = await runHarlan('import("a.b")', { cwd });
  const nested = await formatRejectedError(() =>
    runHarlan('import("a.b.c")', { cwd, sessionSnapshot: first.sessionSnapshot }),
  );

  assert.match(nested, /module `a\.b` cannot be used as a namespace/);
});

test("snapshots restore user library implementations without live reload", async () => {
  const cwd = await createLibraryWorkspace({
    "mymodule/hello.harlan": `
      fn greet() -> String =
        "old"
    `,
  });

  const first = await runHarlan('import("mymodule.hello")', { cwd });
  await writeFile(
    path.join(cwd, "harlan", "mymodule", "hello.harlan"),
    `
      fn greet() -> String =
        "new"
    `,
  );

  const restored = await runHarlan("mymodule.hello.greet()", {
    cwd,
    sessionSnapshot: first.sessionSnapshot,
  });
  const source = await runHarlan("revealImpl(mymodule.hello.greet)", {
    cwd,
    sessionSnapshot: first.sessionSnapshot,
  });

  assert.equal(renderHarlanValue(restored.value), "old");
  assert.equal(renderHarlanValue(source.value), "null");
  assert.match(renderHarlanResult(source), /"old"/);
  assert.doesNotMatch(renderHarlanResult(source), /"new"/);
  assert.doesNotMatch(renderHarlanResult(source), /\nnull$/);
});

test("library function runtime errors use library source diagnostics after restore", async () => {
  const cwd = await createLibraryWorkspace({
    "mymodule/bad.harlan": `
      fn boom() -> String =
        missing.binding
    `,
  });

  const first = await runHarlan('import("mymodule.bad")', { cwd });
  const error = await formatRejectedError(() =>
    runHarlan("mymodule.bad.boom()", { cwd, sessionSnapshot: first.sessionSnapshot }),
  );

  assert.match(error, /unknown binding `missing`/);
  assert.match(error, /missing\.binding/);
  assert.doesNotMatch(error, /mymodule\.bad\.boom\(\)/);
});

function assertRecordBooleans(value: HarlanValue, keys: string[]): void {
  assert.equal(value.kind, "record");
  for (const key of keys) {
    const field: HarlanValue | undefined =
      value.kind === "record" ? value.fields.get(key) : undefined;
    assert.equal(field?.kind, "boolean");
    assert.equal(field?.kind === "boolean" ? field.value : false, true);
  }
}

function formatThrownError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return formatUnknownError(error);
  }

  assert.fail("Expected function to throw");
}

async function formatRejectedError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return formatUnknownError(error);
  }

  assert.fail("Expected promise to reject");
}

async function captureRejectedError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }

  assert.fail("Expected promise to reject");
}

async function createLibraryWorkspace(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "harlan-libs-"));
  for (const [name, source] of Object.entries(files)) {
    const filePath = path.join(cwd, "harlan", name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
  }
  return cwd;
}
