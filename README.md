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

## Built-in Modules

`fs` provides local filesystem access inside the runtime working directory:

```harlan
let fs = import("fs")

fs.cwd()
fs.read("README.md")
fs.list(".")
fs.exists("README.md")
```

`text` provides small text/list helpers:

```harlan
let text = import("text")

text.lines("a\nb")
text.join(["a", "b"], ",")
text.take(["a", "b", "c"], 2)
```

`shell` runs local shell commands when shell execution is enabled by the host:

```harlan
let shell = import("shell")

shell.run("printf hello")
```

## Runtime API

The language can be used directly from TypeScript:

```ts
import { renderHarlanValue, runHarlan } from "./src/harlan/index.ts";

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

console.log(renderHarlanValue(result.value));
```

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run format:check
```
