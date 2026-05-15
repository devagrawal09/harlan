import z from "zod";

export const sessionStartedEvent = z.object({
  session_path: z.string(), // unique identifier of the session, cwd + incrementing number
});

export const userMessagedEvent = z.object({
  session_path: z.string(),
  user_message: z.string(),
});

export const agentRespondedEvent = z.object({
  session_path: z.string(),
  agent_response: z.string(), // final response from the agent after executing code
});

export const agentExecutedEvent = z.object({
  session_path: z.string(),
  harlan_executed: z.string(), // harlan code executed by agent
});

export const executionCompletedEvent = z.object({
  session_path: z.string(),
  result: z.string(), // result returned from executing the code
});

export const domainEventNames = {
  sessionStarted: "sessionStarted",
  userMessaged: "userMessaged",
  agentResponded: "agentResponded",
  agentExecuted: "agentExecuted",
  executionCompleted: "executionCompleted",
} as const;

export const domainEventPayloadSchemas = {
  sessionStarted: sessionStartedEvent,
  userMessaged: userMessagedEvent,
  agentResponded: agentRespondedEvent,
  agentExecuted: agentExecutedEvent,
  executionCompleted: executionCompletedEvent,
} as const;

export const domainEventNameSchema = z.enum(domainEventNames);

export type DomainEventName = keyof typeof domainEventPayloadSchemas;

export type DomainEventPayloadMap = {
  sessionStarted: z.infer<typeof sessionStartedEvent>;
  userMessaged: z.infer<typeof userMessagedEvent>;
  agentResponded: z.infer<typeof agentRespondedEvent>;
  agentExecuted: z.infer<typeof agentExecutedEvent>;
  executionCompleted: z.infer<typeof executionCompletedEvent>;
};

export type DomainEventPayload = DomainEventPayloadMap[DomainEventName];

export type EventLogItem<Name extends DomainEventName = DomainEventName> = {
  id: string;
  name: Name;
  data: DomainEventPayloadMap[Name];
  createdAt: string;
};

export function isDomainEventName(value: string): value is DomainEventName {
  return value in domainEventPayloadSchemas;
}
