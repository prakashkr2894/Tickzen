"use client";

import { apiRequest } from "./api";

export interface ZentrixaContext {
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskTitle?: string;
  userName?: string;
  userId?: string;
  developerId?: string;
  status?: string;
  comment?: string;
  title?: string;
  pendingCommand?: Record<string, unknown> | null;
  routeProjectId?: string;
  [key: string]: unknown;
}

export type ZentrixaAction =
  | "create_project"
  | "delete_project"
  | "rename_project"
  | "analyze_project"
  | "create_task"
  | "delete_task"
  | "assign_task"
  | "move_task"
  | "update_task"
  | "comment_task"
  | "show_delayed"
  | "add_member"
  | "remove_member"
  | "update_deadline";

export interface ZentrixaMessageResult {
  reply?: string;
  message?: string;
  type?: "NORMAL" | "COMMAND" | "CONFIRM" | "CLARIFICATION";
  intent?: string;
  command?: string;
  executed?: boolean;
  requiresConfirmation?: boolean;
  requiresClarification?: boolean;
  missing?: string[];
  payload?: Record<string, unknown>;
  pendingCommand?: Record<string, unknown>;
  suggestions?: string[];
  path?: "local" | "llm";
}

export interface ZentrixaParsedCommand {
  action: string;
  project_name?: string;
  task_name?: string;
  user_name?: string;
  status?: string;
  comment?: string;
  due_date?: string;
  confidence?: number;
}

export interface ZentrixaStoredMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  mode?: "chat" | "command";
  intent?: string;
  projectId?: string | null;
  taskId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export async function sendZentrixaChat(payload: {
  message: string;
  context?: ZentrixaContext;
  taskId?: string;
  projectId?: string;
}): Promise<ZentrixaMessageResult> {
  return apiRequest<ZentrixaMessageResult>("/zentrixa/chat", {
    method: "POST",
    body: JSON.stringify({
      message: payload.message,
      text: payload.message,
      context: payload.context,
      taskId: payload.taskId,
      projectId: payload.projectId,
    }),
  });
}

export async function dispatchZentrixaCommand(payload: {
  action: ZentrixaAction;
  text?: string;
  entities?: Record<string, unknown>;
  context?: ZentrixaContext;
  taskId?: string;
  projectId?: string;
}): Promise<ZentrixaMessageResult> {
  return apiRequest<ZentrixaMessageResult>("/zentrixa/dispatch", {
    method: "POST",
    body: JSON.stringify({
      action: payload.action,
      intent: payload.action,
      text: payload.text,
      entities: payload.entities || {},
      context: payload.context,
      taskId: payload.taskId,
      projectId: payload.projectId,
    }),
  });
}

export async function confirmZentrixaCommand(payload: {
  confirmed: boolean;
  text?: string;
  payload: Record<string, unknown>;
  context?: ZentrixaContext;
}): Promise<ZentrixaMessageResult> {
  return apiRequest<ZentrixaMessageResult>("/zentrixa/confirm", {
    method: "POST",
    body: JSON.stringify({
      confirmed: payload.confirmed,
      text: payload.text,
      payload: payload.payload,
      context: payload.context,
    }),
  });
}

export interface GetMessagesResponse {
  messages: ZentrixaStoredMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function getZentrixaMessages(cursor?: string | null, limit = 5): Promise<GetMessagesResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);

  const response = await apiRequest<GetMessagesResponse>(`/zentrixa/messages?${params.toString()}`);
  return {
    messages: response.messages || [],
    hasMore: Boolean(response.hasMore),
    nextCursor: response.nextCursor || null,
  };
}

export function summarizeParsedCommand(command: ZentrixaParsedCommand) {
  const parts = [`action: ${command.action}`];
  if (command.task_name) parts.push(`task: ${command.task_name}`);
  if (command.project_name) parts.push(`project: ${command.project_name}`);
  if (command.user_name) parts.push(`user: ${command.user_name}`);
  if (command.status) parts.push(`status: ${command.status}`);
  return parts.join(" | ");
}
