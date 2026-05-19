import type { HarlanRunResult, HarlanValue } from "./runtime.ts";

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
      if (value.libraryModuleName) {
        const signatures = value.signatures ?? [];
        if (signatures.length === 0) {
          return `<module ${value.libraryModuleName}: no exported functions>`;
        }
        return [`<module ${value.libraryModuleName}>`, ...signatures.map((sig) => `- ${sig}`)].join(
          "\n",
        );
      }
      return `{ ${[...value.fields.entries()]
        .map(([key, fieldValue]) => `${key}: ${renderHarlanValueForCollection(fieldValue)}`)
        .join(", ")} }`;
    case "function":
      if (value.library) {
        return `<function ${value.library.moduleName}.${value.library.signature}>`;
      }
      return `<function${value.name ? ` ${value.name}` : ""}>`;
  }
}

export function renderHarlanResult(
  result: HarlanRunResult,
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? 20_000;
  const warnings = result.warnings.length > 0 ? `${result.warnings.join("\n")}\n` : "";
  const output = result.output.length > 0 ? `${result.output.join("\n")}\n` : "";
  const renderedValue =
    result.suppressNullValue && result.value.kind === "null" ? "" : renderHarlanValue(result.value);
  return truncateRendered(`${warnings}${output}${renderedValue}`, maxChars);
}

export function harlanValueToJson(value: HarlanValue): unknown {
  switch (value.kind) {
    case "null":
      return null;
    case "string":
    case "number":
    case "boolean":
      return value.value;
    case "list":
      return value.items.map(harlanValueToJson);
    case "record":
      if (value.libraryModuleName) {
        return `<module ${value.libraryModuleName}>`;
      }
      return Object.fromEntries(
        [...value.fields.entries()].map(([key, fieldValue]) => [
          key,
          harlanValueToJson(fieldValue),
        ]),
      );
    case "function":
      if (value.library) {
        return `<function ${value.library.moduleName}.${value.library.signature}>`;
      }
      return `<function${value.name ? ` ${value.name}` : ""}>`;
  }
}

function renderHarlanValueForCollection(value: HarlanValue): string {
  if (value.kind === "string") {
    return JSON.stringify(value.value);
  }

  return renderHarlanValue(value);
}

function truncateRendered(value: string, maxChars: number): string {
  if (maxChars < 1 || value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n... truncated after ${maxChars} characters`;
}
