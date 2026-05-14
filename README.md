# Harlan

Harlan is a small TypeScript CLI for running an agent that can respond to tasks from command-line arguments or standard input by writing Harlan code.

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

## Development

```sh
npm run typecheck
npm run lint
npm run format:check
```
