#!/usr/bin/env node

type CommandContext = {
  args: string[];
};

function printHelp(): void {
  console.log(`harlan

Usage:
  harlan [options] [args...]

Options:
  -h, --help     Show this help message
  -v, --version  Show package version`);
}

async function main({ args }: CommandContext): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  if (args.includes("-v") || args.includes("--version")) {
    const packageJson = await import("../package.json", { with: { type: "json" } });
    console.log(packageJson.default.version);
    return;
  }

  console.log(args.length ? args.join(" ") : "harlan");
}

main({ args: process.argv.slice(2) }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
