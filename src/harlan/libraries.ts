import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FunctionDeclaration, TypeAnnotation } from "./ast.ts";
import { ImportError } from "./errors.ts";
import { parseHarlan } from "./parser.ts";
import type { SourceSpan } from "./tokens.ts";

export type ParsedLibraryModule = {
  moduleName: string;
  source: string;
  path: string;
  program: ReturnType<typeof parseHarlan>;
  functions: FunctionDeclaration[];
};

export function isUserLibrarySpecifier(value: string): boolean {
  return value.includes(".");
}

export function validateUserLibrarySpecifier(
  moduleName: string,
  span: SourceSpan,
  source: string,
): string[] {
  if (moduleName.includes("/") || moduleName.includes("\\")) {
    throw new ImportError(
      `user library imports use dot specifiers, not slash paths: \`${moduleName}\``,
      span,
      source,
      { hints: ['Use a dot import such as `import("mymodule.hello")`.'] },
    );
  }

  const parts = moduleName.split(".");
  if (
    parts.length < 2 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    throw new ImportError(
      `invalid user library import specifier \`${moduleName}\``,
      span,
      source,
      { hints: ['Use a dot import such as `import("mymodule.hello")`.'] },
    );
  }

  return parts;
}

export async function parseLibraryModule(
  moduleName: string,
  libraryRoot: string,
  span: SourceSpan,
  contextSource: string,
): Promise<ParsedLibraryModule> {
  const parts = validateUserLibrarySpecifier(moduleName, span, contextSource);
  const root = path.resolve(libraryRoot);
  const resolved = path.resolve(root, ...parts.slice(0, -1), `${parts.at(-1)!}.harlan`);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ImportError(`library import escapes library root: \`${moduleName}\``, span, contextSource);
  }

  let source: string;
  try {
    source = await readFile(resolved, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ImportError(`unable to import library \`${moduleName}\`: ${message}`, span, contextSource);
  }

  const program = parseHarlan(source);
  return {
    moduleName,
    source,
    path: resolved,
    program,
    functions: program.statements.filter(
      (statement): statement is FunctionDeclaration => statement.kind === "FunctionDeclaration",
    ),
  };
}

export function functionSignature(declaration: FunctionDeclaration): string {
  const params = declaration.params
    .map((param) => `${param.name}${param.type ? `: ${typeAnnotation(param.type)}` : ""}`)
    .join(", ");
  return `${declaration.name}(${params})${
    declaration.returnType ? ` -> ${typeAnnotation(declaration.returnType)}` : ""
  }`;
}

export function functionSource(source: string, declaration: FunctionDeclaration): string {
  return source.slice(declaration.span.start.offset, declaration.span.end.offset);
}

function typeAnnotation(type: TypeAnnotation): string {
  if (type.args.length === 0) {
    return type.name;
  }

  return `${type.name}[${type.args.map(typeAnnotation).join(", ")}]`;
}
