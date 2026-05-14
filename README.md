# Harlan

Harlan is a small TypeScript CLI for running an agent that can respond to tasks by writing and executing Harlan code.

Harlan is also the custom language behind that tool: a small, immutable, ML-flavored workflow language for composing tool calls. The first MVP is focused on local filesystem, shell, and text-processing workflows that an agent can write, run, and reuse.

## Requirements

- Node.js 23.6 or newer
- An API key for the model provider you use

## Setup

Install dependencies:

```sh
npm install
```

Create a local environment file:

```sh
cp .env.example .env
```

Then fill in the required API key. The default model uses OpenRouter, so `OPENROUTER_API_KEY` is required unless you change `HARLAN_MODEL` to another provider.

## Usage

Run Harlan with a task:

```sh
npm start -- "write a short greeting"
```

Or pipe a task through standard input:

```sh
echo "write a short greeting" | npm start
```

Choose a model explicitly:

```sh
npm start -- --model openrouter/google/gemini-2.0-flash-lite-001 "write a short greeting"
```

## Harlan Language

Harlan programs are expression-oriented. A program can define immutable bindings with `let`, define functions with `fn`, call tools, and return the value of the final expression.

Modules are loaded with the built-in `import` function:

```harlan
let fs = import("fs")
let text = import("text")

fs.read("README.md")
  |> text.lines()
  |> text.take(3)
```

The pipeline operator passes the value on the left as the first argument to the function call on the right:

```harlan
"a\nb\nc"
  |> text.lines()
  |> text.take(2)
```

Bindings are immutable:

```harlan
let path = "README.md"
let body = fs.read(path)
```

Functions can have simple type annotations:

```harlan
fn first_lines(path: String, count: Number) -> List[String] =
  fs.read(path)
    |> text.lines()
    |> text.take(count)

first_lines("README.md", 5)
```

Records and lists are supported:

```harlan
let task = {
  path: "README.md",
  count: 5
}

let files = ["README.md", "package.json"]

task.path
```

## Script Logic

Use `if` expressions to branch on tool results:

```harlan
let fs = import("fs")

if fs.exists("README.md") then
  fs.read("README.md")
else
  "README.md is missing"
```

Comparisons and boolean operators work with explicit booleans:

```harlan
let fs = import("fs")
let info = fs.info("README.md")

info.kind == "file" and info.size > 0
```

Destructuring binds structured records and lists returned by helpers:

```harlan
let fs = import("fs")
let format = import("format")

let { matches, truncated } = fs.search("src", "runHarlan")

if truncated then
  "too many results"
else
  format.table(matches)
```

Syntax summary:

- `if condition then a else b`
- `==`, `!=`, `<`, `<=`, `>`, `>=`
- `and`, `or`, `not`
- `null`
- `let { field } = record`
- `let [first] = list`

## Built-in Modules

`fs` provides local filesystem access inside the runtime working directory:

```harlan
let fs = import("fs")

fs.cwd()
fs.read("README.md")
fs.list(".")
fs.exists("README.md")
fs.glob("src/**/*.ts")
fs.search("src", "execute_harlan")
fs.info("README.md")
```

`text` provides small text/list helpers:

```harlan
let text = import("text")

text.lines("a\nb")
text.join(["a", "b"], ",")
text.take(["a", "b", "c"], 2)
text.contains("abc", "b")
text.trim("  abc  ")
text.lower("ABC")
text.includes(["a", "b"], "b")
```

`format` turns Harlan values into readable strings:

```harlan
let format = import("format")

format.json({ path: "README.md", count: 3 })
format.lines(["README.md", "package.json"])
format.table([{ path: "src/cli.ts", line: 74 }])
```

`shell` runs local shell commands when shell execution is enabled by the host:

```harlan
let shell = import("shell")

shell.run("printf hello")
```

| Module   | Functions                                                        |
| -------- | ---------------------------------------------------------------- |
| `fs`     | `cwd`, `read`, `list`, `exists`, `glob`, `search`, `info`        |
| `text`   | `lines`, `join`, `take`, `contains`, `trim`, `lower`, `includes` |
| `format` | `json`, `lines`, `table`                                         |
| `shell`  | `run`                                                            |

## Agent Workflow Examples

Prefer Harlan's built-in inspection helpers before reaching for shell commands. Use `fs.glob` for file discovery, `fs.search` for code search, and `format.table` for compact structured results. Use `shell.run` only when the built-in modules are not enough.

Search code and return a Markdown table:

```harlan
let fs = import("fs")
let format = import("format")

fs.search("src", "execute_harlan").matches
  |> format.table()
```

List source files:

```harlan
let fs = import("fs")
let format = import("format")

fs.glob("src/**/*.ts")
  |> format.lines()
```

Summarize the beginning of the README:

```harlan
let fs = import("fs")
let text = import("text")

fs.read("README.md")
  |> text.lines()
  |> text.take(10)
```

Example scripts live in `examples/`:

- `examples/readme-summary.harlan`
- `examples/search-code.harlan`
- `examples/list-source.harlan`

## Runtime API

The language can be used directly from TypeScript:

```ts
import { renderHarlanResult, runHarlan } from "./src/harlan/index.ts";

const result = await runHarlan(
  `
    let fs = import("fs")
    let text = import("text")

    fs.read("README.md")
      |> text.lines()
      |> text.take(3)
  `,
  { cwd: process.cwd(), allowShell: true },
);

console.log(renderHarlanResult(result));
```

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run format:check
```
