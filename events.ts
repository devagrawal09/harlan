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
