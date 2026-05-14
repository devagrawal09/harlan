import type { SourceSpan } from "./tokens.ts";

export type Program = {
  kind: "Program";
  statements: Statement[];
  span: SourceSpan;
};

export type Statement = LetDeclaration | FunctionDeclaration | ExpressionStatement;

export type LetDeclaration = {
  kind: "LetDeclaration";
  pattern: BindingPattern;
  value: Expression;
  span: SourceSpan;
};

export type BindingPattern = IdentifierPattern | RecordPattern | ListPattern;

export type IdentifierPattern = {
  kind: "IdentifierPattern";
  name: string;
  span: SourceSpan;
};

export type RecordPattern = {
  kind: "RecordPattern";
  fields: RecordPatternField[];
  span: SourceSpan;
};

export type RecordPatternField = {
  name: string;
  pattern: BindingPattern;
  span: SourceSpan;
};

export type ListPattern = {
  kind: "ListPattern";
  items: BindingPattern[];
  span: SourceSpan;
};

export type FunctionDeclaration = {
  kind: "FunctionDeclaration";
  name: string;
  params: FunctionParam[];
  returnType: TypeAnnotation | null;
  body: Expression;
  span: SourceSpan;
};

export type FunctionParam = {
  name: string;
  type: TypeAnnotation | null;
};

export type TypeAnnotation = {
  name: string;
  args: TypeAnnotation[];
  span: SourceSpan;
};

export type ExpressionStatement = {
  kind: "ExpressionStatement";
  expression: Expression;
  span: SourceSpan;
};

export type Expression =
  | StringLiteral
  | NumberLiteral
  | BooleanLiteral
  | NullLiteral
  | IfExpression
  | BinaryExpression
  | UnaryExpression
  | IdentifierExpression
  | ListExpression
  | RecordExpression
  | MemberExpression
  | CallExpression
  | PipelineExpression;

export type StringLiteral = {
  kind: "StringLiteral";
  value: string;
  span: SourceSpan;
};

export type NumberLiteral = {
  kind: "NumberLiteral";
  value: number;
  span: SourceSpan;
};

export type BooleanLiteral = {
  kind: "BooleanLiteral";
  value: boolean;
  span: SourceSpan;
};

export type NullLiteral = {
  kind: "NullLiteral";
  span: SourceSpan;
};

export type IfExpression = {
  kind: "IfExpression";
  condition: Expression;
  thenBranch: Expression;
  elseBranch: Expression;
  span: SourceSpan;
};

export type BinaryExpression = {
  kind: "BinaryExpression";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
  span: SourceSpan;
};

export type UnaryExpression = {
  kind: "UnaryExpression";
  operator: "not";
  argument: Expression;
  span: SourceSpan;
};

export type BinaryOperator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type IdentifierExpression = {
  kind: "IdentifierExpression";
  name: string;
  span: SourceSpan;
};

export type ListExpression = {
  kind: "ListExpression";
  items: Expression[];
  span: SourceSpan;
};

export type RecordExpression = {
  kind: "RecordExpression";
  fields: RecordField[];
  span: SourceSpan;
};

export type RecordField = {
  name: string;
  value: Expression;
  span: SourceSpan;
};

export type MemberExpression = {
  kind: "MemberExpression";
  object: Expression;
  property: string;
  span: SourceSpan;
};

export type CallExpression = {
  kind: "CallExpression";
  callee: Expression;
  args: Expression[];
  span: SourceSpan;
};

export type PipelineExpression = {
  kind: "PipelineExpression";
  left: Expression;
  right: Expression;
  span: SourceSpan;
};
