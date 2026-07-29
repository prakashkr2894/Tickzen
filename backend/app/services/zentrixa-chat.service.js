/**
 * Zentrixa Chat Service — Backend-First Architecture
 * ===================================================
 * 95–100 % of responses handled directly by backend.
 * LLM called ONLY for genuine open-ended questions (≤ 5 %).
 *
 * Pipeline:
 *  1. Python engine classifies text → intent + confidence + entities
 *  2. Global intents (greet/confirm/deny/cancel) → instant backend response
 *  3. Command intent recognised  → intentHandler() → confirm card OR clarify question
 *  4. Unknown intent + "?" text  → LLM (last resort)
 *  5. Unknown intent + no "?"    → smart fixed fallback
 *
 * Entry points exported:
 *  handleMessage      POST /zentrixa/chat
 *  handleConfirm      POST /zentrixa/confirm
 *  getZentrixaMessages  GET /zentrixa/messages
 *  clearZentrixaNotifications  DELETE /zentrixa/notifications
 *  saveZentrixaMessage (utility, used by voice route)
 *  getOpenAIChatReply  (utility, used by project-chat)
 */

import mongoose from 'mongoose';
import Project from '../models/Project.js';
import Panel from '../models/Panel.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import ProjectRequest from '../models/ProjectRequest.js';
import Notification from '../models/Notification.js';
import ZentrixaChatMessage from '../models/ZentrixaChatMessage.js';
import { createProject, deleteProject, inviteDeveloper, removeProjectMember, updateProject } from '../controllers/project.controller.js';
import { createTask, deleteTask, updateTask, updateTaskStatus, addTaskComment } from '../controllers/task.controller.js';
import { extractEntities } from '../utils/entityExtractor.js';
import { resolveProjectTitle, resolveTaskTitle, resolveUserName, resolveAllEntities } from '../utils/entityResolver.js';

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/** Intents only admins may trigger */
const ADMIN_ONLY_INTENTS = new Set([
  'create_project', 'delete_project', 'rename_project',
  'add_member', 'remove_member', 'assign_task',
  'delete_task', 'update_deadline',
]);

// ─────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────
const normalize       = (v = '') => v.replace(/\s+/g, ' ').trim();
const escapeRegExp    = (v = '') => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const buildRegex      = (v = '') => new RegExp(escapeRegExp(normalize(v)), 'i');
const normalizeKey    = (v = '') => normalize(v).toLowerCase().replace(/[\s_-]+/g, '_');
const isObjectId      = (v)       => mongoose.Types.ObjectId.isValid(v);
const formatName      = (u)       => u?.name || 'someone';
const formatTaskTitle = (t)       => t?.title || 'task';

export const isAffirmativeCommand = (text = '') => {
  const c = normalize(text).replace(/[.,!?]+/g, '').trim();
  return /^(yes|yep|yeah|confirm|do it|doit|add|proceed|ok|okay|sure|yes please|absolutely|go ahead|definitely)$/i.test(c);
};

export const isNegativeCommand = (text = '') => {
  const c = normalize(text).replace(/[.,!?]+/g, '').trim();
  return /^(no|nope|cancel|stop|never mind|nevermind|dont|don't|no thanks|abort|nah|negative)$/i.test(c);
};

// ─────────────────────────────────────────────────────────────────
// Mock response (used to run Express controllers in service layer)
// ─────────────────────────────────────────────────────────────────
const createMockRes = () => {
  const s = { statusCode: 200, body: null };
  return {
    status(code) { s.statusCode = code; return this; },
    json(payload) { s.body = payload; return this; },
    getState() { return s; },
  };
};

export const runController = async (controller, req) => {
  const mockRes = createMockRes();
  await controller(req, mockRes);
  return mockRes.getState();
};

// ─────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────
const findProjectByName = (name) =>
  name ? Project.findOne({ name: buildRegex(name) }) : null;

const findUserByName = async (userName) => {
  if (!userName) return null;
  const t = normalize(userName);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
  return User.findOne({
    $or: [
      { name: buildRegex(t) },
      ...(isEmail ? [{ email: new RegExp(`^${escapeRegExp(t)}$`, 'i') }] : []),
    ],
  }).select('_id name email role');
};

const findTaskByName = ({ taskName, projectId }) => {
  const q = {};
  if (taskName)  q.title     = buildRegex(taskName);
  if (projectId) q.projectId = projectId;
  return Task.findOne(q)
    .populate('projectId', 'name')
    .populate('assignedDeveloper', 'name email role');
};

const findTaskByIdSafe = (taskId) =>
  isObjectId(taskId)
    ? Task.findById(taskId)
        .populate('projectId', 'name')
        .populate('assignedDeveloper', 'name email role')
    : null;

const queryOverdueTasks = ({ projectId, user }) => {
  const q = { deadline: { $lt: new Date() }, status: { $nin: ['completed', 'done'] } };
  if (projectId)              q.projectId           = projectId;
  if (user?.role === 'developer') q.assignedDeveloper = user._id;
  return Task.find(q)
    .populate('assignedDeveloper', 'name email role')
    .populate('projectId', 'name')
    .sort({ deadline: 1 });
};

const addDeveloperToProject = async ({ projectId, userId }) => {
  if (!projectId || !userId) return { ok: false, reply: 'projectId and userId are required.' };
  const [project, developer] = await Promise.all([
    Project.findById(projectId).populate('developers', 'name email role'),
    User.findById(userId).select('_id name email role'),
  ]);
  if (!project)                           return { ok: false, reply: 'Project not found.' };
  if (!developer || developer.role !== 'developer')
                                          return { ok: false, reply: 'Developer not found.' };
  const already = (project.developers || []).some(
    m => m?._id?.toString() === developer._id.toString()
  );
  if (already) return { ok: true, executed: false, reply: `${formatName(developer)} is already in ${project.name}.` };

  await Promise.all([
    Project.updateOne({ _id: projectId }, { $addToSet: { developers: developer._id } }),
    User.updateOne({ _id: developer._id }, { $addToSet: { joinedProjects: projectId } }),
    ProjectRequest.deleteMany({ projectId, developerId: developer._id }),
  ]);
  return { ok: true, executed: true, reply: `${formatName(developer)} has been added to ${project.name}.` };
};

// ─────────────────────────────────────────────────────────────────
// Project name extraction from raw text
// ─────────────────────────────────────────────────────────────────
const extractProjectNameHint = (text = '') => {
  const n = normalize(text);
  const patterns = [
    /(?:create|make|start|build)\s+(?:a\s+|the\s+)?(?:new\s+)?project\s+(?:with\s+name|name\s+with|with|named?|called|titled|title|is|name)?\s*(.+?)(?:\s+for\b|\s+in\b|\s+on\b|\s+please\b|$)/i,
    /(?:new\s+project)\s+(?:with\s+name|name\s+with|with|named?|called|titled|title|is|name)?\s*(.+?)(?:\s+for\b|\s+in\b|\s+on\b|\s+please\b|$)/i,
    /project\s+(?:named?|called|with\s+name|titled)\s+["']?([^"']+?)["']?(?:\s|$)/i,
    /(?:set\s+up|setup|initiate?)\s+(?:a\s+)?project\s+(?:named?|called|with\s+name|for)?\s+(.+?)(?:\s|$)/i,
  ];
  for (const p of patterns) {
    const m = n.match(p);
    if (m?.[1]) {
      const cleaned = m[1]
        .replace(/^(?:name\s+with|with\s+name|with|name|named|called|titled|title|is)\s+/i, '')
        .replace(/\b(project|task|board|card)\b/gi, '')
        .replace(/\b(my|this|that|the|a|an)\b/gi, '')
        .replace(/[.,!?]+$/, '')
        .trim();
      if (cleaned) return cleaned;
    }
  }
  return '';
};

// ─────────────────────────────────────────────────────────────────
// History persistence
// ─────────────────────────────────────────────────────────────────
export const saveZentrixaMessage = async ({
  userId, role, content, mode = 'chat', intent = 'unknown',
  projectId = null, taskId = null, metadata = {},
}) => {
  if (!userId || !content) return null;
  try {
    return await ZentrixaChatMessage.create({
      userId, role, content, mode, intent,
      projectId: projectId || null,
      taskId:    taskId    || null,
      metadata,
    });
  } catch (e) {
    console.error('[Zentrixa] History save error:', e.message);
    return null;
  }
};

const saveExchange = (userId, userText, assistantReply, intent, context = {}) => {
  const mode = intent && intent !== 'unknown' ? 'command' : 'chat';
  const projectId = context.projectId || null;
  const taskId    = context.taskId    || null;
  void Promise.all([
    saveZentrixaMessage({ userId, role: 'user',      content: userText,       mode, intent, projectId, taskId }),
    saveZentrixaMessage({ userId, role: 'assistant', content: assistantReply, mode, intent, projectId, taskId }),
  ]);
};

const getZentrixaHistory = async (userId, limit = 5, cursor = null) => {
  if (!userId) return { messages: [], hasMore: false, nextCursor: null };
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 50);
  const query = { userId };
  if (cursor && isObjectId(cursor)) query._id = { $lt: new mongoose.Types.ObjectId(cursor) };

  const items = await ZentrixaChatMessage.find(query)
    .sort({ _id: -1 }).limit(safeLimit + 1)
    .populate('projectId', 'name').populate('taskId', 'title').lean();

  const hasMore = items.length > safeLimit;
  const messages = hasMore ? items.slice(0, safeLimit) : items;
  return {
    messages,
    hasMore,
    nextCursor: hasMore && messages.length ? messages[messages.length - 1]._id.toString() : null,
  };
};

// ─────────────────────────────────────────────────────────────────
// Python Intent Engine
// ─────────────────────────────────────────────────────────────────
const classifyWithPython = async (text) => {
  // ZENTRIXA_AI_URL may include the full path (legacy) or just the base.
  // e.g. http://zentrixa-ai:8001  OR  http://zentrixa-ai:8001/zentrixa
  const rawUrl   = process.env.ZENTRIXA_AI_URL || 'http://127.0.0.1:8001';
  const baseUrl  = rawUrl.replace(/\/(zentrixa|ai\/parse)?\/?$/, '');
  const endpoint = `${baseUrl}/intent/classify`;
  const ctrl     = new AbortController();
  const timer    = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// ─────────────────────────────────────────────────────────────────
// LLM — called for genuine questions only (≤ 5 % of traffic)
// ─────────────────────────────────────────────────────────────────
export async function getOpenAIChatReply({ user, text, context = {} }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return buildFallbackResponse(user);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are Zentrixa, a warm project-management assistant. Reply concisely and naturally. Never mention JSON, APIs, or internal systems.',
          },
          {
            role: 'user',
            content: `User role: ${user?.role || 'developer'}\nProject: ${context.projectName || 'none'}\nMessage: ${text}`,
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    return normalize(data.choices?.[0]?.message?.content || '') || buildFallbackResponse(user);
  } catch (e) {
    console.error('[Zentrixa] OpenAI error:', e.message);
    return buildFallbackResponse(user);
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────
// Role guard
// ─────────────────────────────────────────────────────────────────
const ensureRole = (user, intent) => {
  if (!ADMIN_ONLY_INTENTS.has(intent)) return null;
  if (user?.role === 'admin') return null;
  return `You don't have permission to ${intent.replace(/_/g, ' ')}. Ask an admin.`;
};

// ─────────────────────────────────────────────────────────────────
// Response builders
// ─────────────────────────────────────────────────────────────────
const buildConfirm = (command, message, payload) => ({
  executed: false,
  mode: 'command',
  type: 'CONFIRM',
  command: command.toUpperCase(),
  reply: message,
  message,
  payload: { command: command.toUpperCase(), ...payload },
  requiresConfirmation: true,
});

const buildClarify = (reply, intent, partial = {}) => ({
  executed: false,
  mode: 'command',
  reply,
  requiresClarification: true,
  pendingCommand: { intent, ...partial },
});

const buildFallbackResponse = (user) =>
  user?.role === 'admin'
    ? 'I can help you manage projects and tasks. Try:\n• "Create project Alpha"\n• "Delete project Beta"\n• "Show overdue tasks"'
    : 'I can help you with tasks. Try:\n• "Create task Fix login bug"\n• "Move task to in-progress"\n• "Show overdue tasks"';

// ─────────────────────────────────────────────────────────────────
// Individual Intent Handlers — pure backend, no LLM
// ─────────────────────────────────────────────────────────────────
const intentCreateProject = async (user, text, entities, ctx) => {
  const name = extractProjectNameHint(text)
    || entities.project_name || entities.name
    || ctx.projectName || ctx.name || '';
  if (!name) return buildClarify('What would you like to name the new project?', 'create_project', { text });
  const existing = await Project.findOne({
    createdBy: user._id,
    name: new RegExp(`^${escapeRegExp(normalize(name))}$`, 'i'),
  });
  if (existing) return { executed: false, mode: 'command', reply: `Project "${existing.name}" already exists.` };
  return buildConfirm('CREATE_PROJECT', `Shall I create a new project named "${name}"?`, {
    name, title: name, project_name: name, projectName: name,
    description: entities.description || ctx.description || '',
  });
};

const intentDeleteProject = async (user, text, entities, ctx) => {
  const name = entities.project_name || ctx.projectName || '';
  if (!name) return buildClarify('Which project would you like to delete?', 'delete_project', { text });
  const project = await findProjectByName(name);
  if (!project) return { executed: false, mode: 'command', reply: `I couldn't find a project named "${name}".` };
  return buildConfirm('DELETE_PROJECT', `Are you sure you want to delete "${project.name}"? This cannot be undone.`, {
    projectId: project._id.toString(), projectName: project.name,
  });
};

const intentRenameProject = async (user, text, entities, ctx) => {
  const name    = entities.project_name || ctx.projectName || '';
  const newName = entities.new_name || ctx.newName || '';
  if (!name)    return buildClarify('Which project would you like to rename?', 'rename_project', { text, new_name: newName });
  if (!newName) return buildClarify(`What should "${name}" be renamed to?`, 'rename_project', { text, project_name: name });
  const project = await findProjectByName(name);
  if (!project) return { executed: false, mode: 'command', reply: `I couldn't find a project named "${name}".` };
  return buildConfirm('RENAME_PROJECT', `Rename "${project.name}" to "${newName}"?`, {
    projectId: project._id.toString(), projectName: project.name,
    newName, new_name: newName,
  });
};

const intentAnalyzeProject = async (user, text, entities, ctx) => {
  const resolveId = async () => {
    if (ctx.projectId && isObjectId(ctx.projectId)) return ctx.projectId;
    const name = entities.project_name || ctx.projectName || '';
    if (!name) return null;
    const p = await findProjectByName(name);
    return p?._id || null;
  };
  const projectId = await resolveId();
  if (!projectId) return buildClarify('Which project would you like me to analyze?', 'analyze_project', { text });

  const [project, tasks] = await Promise.all([
    Project.findById(projectId).select('name'),
    Task.find({ projectId }).lean(),
  ]);
  const total     = tasks.length;
  const completed = tasks.filter(t => t.status === 'completed' || t.approvedByAdmin).length;
  const inProg    = tasks.filter(t => t.status === 'in-progress').length;
  const pending   = tasks.filter(t => !t.status || t.status === 'pending').length;
  return {
    executed: true, mode: 'command',
    reply: `${project?.name || 'Project'}: ${total} task${total !== 1 ? 's' : ''} — ${completed} completed, ${inProg} in progress, ${pending} pending.`,
  };
};

const intentCreateTask = async (user, text, entities, ctx) => {
  const taskName  = entities.task_name || entities.title || ctx.taskName || ctx.title || '';
  const projectId = ctx.projectId || entities.project_id || null;
  const projName  = ctx.projectName || entities.project_name || '';
  if (!taskName) return buildClarify('What should the task be called?', 'create_task', { text, project_id: projectId, project_name: projName });

  const userName   = entities.user_name || ctx.userName || '';
  const assignee   = userName ? await findUserByName(userName) : null;
  let panelId      = ctx.panelId || null;
  if (!panelId && projectId && isObjectId(projectId)) {
    const panels = await Panel.find({ projectId }).sort({ order: 1 });
    const todo   = panels.find(p => /(todo|pending|backlog)/i.test(p.name)) || panels[0];
    panelId      = todo?._id?.toString() || null;
  }

  const confirmMsg = assignee
    ? `Create task "${taskName}" in ${projName || 'the project'} and assign to ${formatName(assignee)}?`
    : `Create task "${taskName}" in ${projName || 'the project'}?`;

  return buildConfirm('CREATE_TASK', confirmMsg, {
    title: taskName, task_name: taskName, taskName,
    projectId, projectName: projName, panelId,
    userId:   assignee?._id?.toString() || null,
    userName: assignee ? formatName(assignee) : null,
    priority: entities.priority || ctx.priority || 'medium',
    deadline: entities.deadline || ctx.deadline || null,
  });
};

const intentDeleteTask = async (user, text, entities, ctx) => {
  const taskName  = entities.task_name || ctx.taskName || '';
  const projectId = ctx.projectId || entities.project_id || null;
  if (!taskName) return buildClarify('Which task would you like to delete?', 'delete_task', { text, project_id: projectId });
  const task = await findTaskByName({ taskName, projectId });
  if (!task) return { executed: false, mode: 'command', reply: `I couldn't find a task matching "${taskName}".` };
  return buildConfirm('DELETE_TASK', `Delete task "${task.title}" from ${task.projectId?.name || ctx.projectName || 'this project'}?`, {
    taskId: task._id.toString(), taskName: task.title,
    projectId: task.projectId?._id?.toString() || (projectId ? projectId.toString() : null),
    projectName: task.projectId?.name || ctx.projectName || '',
  });
};

const intentAssignTask = async (user, text, entities, ctx) => {
  const taskName = entities.task_name || ctx.taskName || '';
  const userName = entities.user_name || ctx.userName || '';
  const taskId   = ctx.taskId || null;
  if (!taskName && !taskId) return buildClarify('Which task would you like to assign?', 'assign_task', { text });
  if (!userName)            return buildClarify('Who would you like to assign the task to?', 'assign_task', { text, task_name: taskName, task_id: taskId });
  const [task, devUser] = await Promise.all([
    taskId ? findTaskByIdSafe(taskId) : findTaskByName({ taskName, projectId: ctx.projectId }),
    findUserByName(userName),
  ]);
  if (!task)    return { executed: false, mode: 'command', reply: 'I couldn\'t find the task.' };
  if (!devUser) return { executed: false, mode: 'command', reply: `I couldn't find a user named "${userName}".` };
  return buildConfirm('ASSIGN_TASK', `Assign "${formatTaskTitle(task)}" to ${formatName(devUser)}?`, {
    taskId: task._id.toString(), taskName: task.title,
    userId: devUser._id.toString(), userName: formatName(devUser),
    projectId: task.projectId?._id?.toString() || ctx.projectId || null,
  });
};

const intentMoveTask = async (user, text, entities, ctx) => {
  const taskName = entities.task_name || ctx.taskName || '';
  const status   = entities.status || ctx.status || 'in-progress';
  const taskId   = ctx.taskId || null;
  if (!taskName && !taskId) return buildClarify('Which task would you like to move?', 'move_task', { text, status });
  const task = taskId
    ? await findTaskByIdSafe(taskId)
    : await findTaskByName({ taskName, projectId: ctx.projectId });
  if (!task) return { executed: false, mode: 'command', reply: 'I couldn\'t find the task.' };
  return buildConfirm('MOVE_TASK', `Move "${formatTaskTitle(task)}" to ${status}?`, {
    taskId: task._id.toString(), taskName: task.title, status,
    panelId: ctx.panelId || null,
  });
};

const intentUpdateTask = async (user, text, entities, ctx) => {
  const taskId   = ctx.taskId || null;
  const taskName = entities.task_name || ctx.taskName || '';
  if (!taskId && !taskName) return buildClarify('Which task would you like to update?', 'update_task', { text });
  const task = taskId
    ? await findTaskByIdSafe(taskId)
    : await findTaskByName({ taskName, projectId: ctx.projectId });
  if (!task) return { executed: false, mode: 'command', reply: 'I couldn\'t find the task.' };
  const newTitle    = entities.new_name || entities.title || ctx.newTitle || '';
  const description = entities.description || ctx.description || '';
  const deadline    = entities.deadline || ctx.deadline || '';
  if (!newTitle && !description && !deadline) {
    return buildClarify(
      `What would you like to update on "${formatTaskTitle(task)}"? (name, description, or deadline)`,
      'update_task',
      { text, task_id: task._id.toString(), task_name: task.title }
    );
  }
  return buildConfirm('UPDATE_TASK', `Update task "${formatTaskTitle(task)}"?`, {
    taskId: task._id.toString(), taskName: task.title,
    title: newTitle || task.title, description, deadline,
  });
};

const intentCommentTask = async (user, text, entities, ctx) => {
  const taskId   = ctx.taskId || null;
  const taskName = entities.task_name || ctx.taskName || '';
  const comment  = entities.comment || ctx.comment || '';
  if (!taskId && !taskName) return buildClarify('Which task would you like to comment on?', 'comment_task', { text, comment });
  const task = taskId
    ? await findTaskByIdSafe(taskId)
    : await findTaskByName({ taskName, projectId: ctx.projectId });
  if (!task) return { executed: false, mode: 'command', reply: 'I couldn\'t find the task.' };
  if (!comment)  return buildClarify(`What comment would you like to add to "${formatTaskTitle(task)}"?`, 'comment_task', { text, task_id: task._id.toString(), task_name: task.title });
  return buildConfirm('COMMENT_TASK', `Add comment to "${formatTaskTitle(task)}"?`, {
    taskId: task._id.toString(), taskName: task.title,
    comment, content: comment,
  });
};

const intentShowDelayed = async (user, text, entities, ctx) => {
  const tasks = await queryOverdueTasks({ projectId: ctx.projectId, user });
  if (!tasks.length) return { executed: true, mode: 'command', reply: 'Great news — no overdue tasks!' };
  const list = tasks.slice(0, 5).map(t => `• ${t.title} (${t.projectId?.name || 'unknown project'})`).join('\n');
  const more = tasks.length > 5 ? `\n...and ${tasks.length - 5} more.` : '';
  return {
    executed: true, mode: 'command',
    reply: `You have ${tasks.length} overdue task${tasks.length > 1 ? 's' : ''}:\n${list}${more}`,
  };
};

const intentAddMember = async (user, text, entities, ctx) => {
  const userName  = entities.user_name || ctx.userName || '';
  const projectId = ctx.projectId || entities.project_id || null;
  const projName  = ctx.projectName || entities.project_name || '';
  if (!userName)   return buildClarify('Who would you like to invite?', 'add_member', { text, project_id: projectId, project_name: projName });
  const devUser = await findUserByName(userName);
  if (!devUser) return { executed: false, mode: 'command', reply: `I couldn't find a developer named "${userName}".` };
  if (!projectId) return buildClarify(`Which project should ${formatName(devUser)} join?`, 'add_member', { text, user_id: devUser._id.toString(), user_name: formatName(devUser) });
  return buildConfirm('ADD_MEMBER', `Add ${formatName(devUser)} to ${projName || 'the project'}?`, {
    projectId: projectId.toString(), projectName: projName,
    userId: devUser._id.toString(), userName: formatName(devUser),
  });
};

const intentRemoveMember = async (user, text, entities, ctx) => {
  const userName  = entities.user_name || ctx.userName || '';
  const projectId = ctx.projectId || entities.project_id || null;
  const projName  = ctx.projectName || entities.project_name || '';
  if (!userName)  return buildClarify('Who would you like to remove from the project?', 'remove_member', { text });
  const devUser = await findUserByName(userName);
  if (!devUser) return { executed: false, mode: 'command', reply: `I couldn't find a user named "${userName}".` };
  if (!projectId) return buildClarify(`Which project should ${formatName(devUser)} be removed from?`, 'remove_member', { text, user_id: devUser._id.toString(), user_name: formatName(devUser) });
  return buildConfirm('REMOVE_MEMBER', `Remove ${formatName(devUser)} from ${projName || 'the project'}?`, {
    projectId: projectId.toString(), projectName: projName,
    userId: devUser._id.toString(), userName: formatName(devUser),
  });
};

const intentUpdateDeadline = async (user, text, entities, ctx) => {
  const taskId   = ctx.taskId || null;
  const taskName = entities.task_name || ctx.taskName || '';
  const deadline = entities.deadline || entities.date || ctx.deadline || '';
  if (!taskId && !taskName) return buildClarify('Which task deadline would you like to update?', 'update_deadline', { text, deadline });
  if (!deadline)            return buildClarify('What is the new deadline? (e.g. "July 30" or "next Friday")', 'update_deadline', { text, task_id: taskId, task_name: taskName });
  const task = taskId
    ? await findTaskByIdSafe(taskId)
    : await findTaskByName({ taskName, projectId: ctx.projectId });
  if (!task) return { executed: false, mode: 'command', reply: 'I couldn\'t find the task.' };
  return buildConfirm('UPDATE_DEADLINE', `Update deadline for "${formatTaskTitle(task)}" to ${deadline}?`, {
    taskId: task._id.toString(), taskName: task.title, deadline,
  });
};

// ─────────────────────────────────────────────────────────────────
// Extra intent handlers for Python plugin intents not in old system
// ─────────────────────────────────────────────────────────────────
const intentShowTeam = async (user, text, entities, ctx) => {
  const projectId = ctx.projectId || null;
  if (!projectId || !isObjectId(projectId)) {
    return { executed: true, mode: 'command', reply: 'Open a project to see its team members.' };
  }
  const project = await Project.findById(projectId)
    .populate('developers', 'name email role')
    .populate('createdBy', 'name email role');
  if (!project) return { executed: false, mode: 'command', reply: 'Project not found.' };
  const members = [
    ...(project.createdBy ? [`• ${formatName(project.createdBy)} (admin)`] : []),
    ...(project.developers || []).map(d => `• ${formatName(d)} (developer)`),
  ];
  return {
    executed: true, mode: 'command',
    reply: members.length
      ? `${project.name} team:\n${members.join('\n')}`
      : 'No team members yet.',
  };
};

const intentNavHint = (destination) => async () => ({
  executed: true, mode: 'chat',
  reply: `Sure! Navigate to the ${destination} section from the sidebar.`,
});

const intentUnsupported = (label) => async () => ({
  executed: false, mode: 'chat',
  reply: `${label} is not yet supported through chat. Use the app interface.`,
});

// ─────────────────────────────────────────────────────────────────
// Intent dispatch table — maps ALL Python plugin intent names
// (Python returns UPPERCASE; service lowercases before lookup)
// ─────────────────────────────────────────────────────────────────
const INTENT_HANDLERS = {
  // ── Project
  create_project:   intentCreateProject,
  delete_project:   intentDeleteProject,
  rename_project:   intentRenameProject,
  analyze_project:  intentAnalyzeProject,
  open_project:     intentNavHint('project'),
  search_project:   intentNavHint('project search'),

  // ── Task CRUD
  create_task:      intentCreateTask,
  delete_task:      intentDeleteTask,
  assign_task:      intentAssignTask,
  update_task:      intentUpdateTask,
  move_task:        intentMoveTask,
  comment_task:     intentCommentTask,
  archive_task:     intentUnsupported('Task archiving'),
  restore_task:     intentUnsupported('Task restore'),

  // ── Status / Priority aliases (Python uses these names)
  change_status:    intentMoveTask,
  mark_complete:    async (user, text, entities, ctx) => {
    entities.status = 'completed';
    return intentMoveTask(user, text, entities, ctx);
  },
  change_priority:  intentUpdateTask,

  // ── Views
  show_delayed:     intentShowDelayed,
  show_deadlines:   intentShowDelayed,   // Python alias
  list_tasks:       intentShowDelayed,
  show_dashboard:   intentNavHint('dashboard'),
  show_calendar:    intentNavHint('calendar'),
  show_notifications: intentNavHint('notifications'),
  show_team_members:  intentShowTeam,
  search_task:      intentNavHint('task search'),

  // ── Team
  add_member:       intentAddMember,
  remove_member:    intentRemoveMember,

  // ── Time tracking
  log_time:         intentUnsupported('Time logging'),
  start_timer:      intentUnsupported('Timer'),
  stop_timer:       intentUnsupported('Timer'),

  // ── Deadline & Notes
  update_deadline:  intentUpdateDeadline,
  create_note:      intentCommentTask,   // maps to comment on task

  // ── Sprint
  create_sprint:    intentUnsupported('Sprint creation'),
  start_sprint:     intentUnsupported('Sprint management'),
  end_sprint:       intentUnsupported('Sprint management'),
};

// ─────────────────────────────────────────────────────────────────
// Execute after user confirms ("yes") — runs actual DB operation
// ─────────────────────────────────────────────────────────────────
export const executeConfirmedCommand = async ({ user, text, context = {}, payload = {} }) => {
  const command = normalizeKey(payload.command || payload.intent || payload.action || '');
  if (!command) return { executed: false, mode: 'command', reply: 'I could not confirm that action.' };

  if (command === 'add_member') {
    const result = await addDeveloperToProject({
      projectId: payload.projectId || payload.project_id || context.projectId,
      userId:    payload.userId    || payload.user_id    || context.userId,
    });
    return { executed: Boolean(result.executed), mode: 'command', reply: result.reply };
  }

  if (command === 'remove_member') {
    const result = await runController(removeProjectMember, {
      ...context, user, userId: user?._id,
      params: {
        id:       (payload.projectId || payload.project_id || context.projectId || '').toString(),
        memberId: (payload.userId    || payload.user_id    || context.userId    || '').toString(),
      },
      body: {},
    });
    return { executed: result.statusCode < 400, mode: 'command', reply: result.body?.message || 'Member removed.' };
  }

  if (command === 'create_project') {
    const targetName = resolveProjectTitle(payload, context, text);
    const existing   = targetName
      ? await Project.findOne({ createdBy: user._id, name: new RegExp(`^${escapeRegExp(normalize(targetName))}$`, 'i') })
      : null;
    if (existing) return { executed: false, mode: 'command', reply: `Project "${existing.name}" already exists.` };
    const result  = await runController(createProject, {
      ...context, user, userId: user?._id,
      body: {
        name:             targetName,
        description:      payload.description      || context.description      || '',
        githubRepository: payload.githubRepository || context.githubRepository || '',
      },
    });
    const project = result.body?.project || null;
    return {
      executed: result.statusCode < 400, mode: 'command',
      reply: project ? `Project "${project.name}" created.` : result.body?.message || 'Project created.',
    };
  }

  if (command === 'delete_project') {
    const projectId = payload.projectId || payload.project_id;
    if (!projectId) return { executed: false, mode: 'command', reply: 'Project not found.' };
    const result = await runController(deleteProject, {
      ...context, params: { id: projectId.toString() }, user, userId: user?._id, body: {},
    });
    return { executed: result.statusCode < 400, mode: 'command', reply: result.body?.message || 'Project deleted.' };
  }

  if (command === 'rename_project') {
    const projectId = payload.projectId || payload.project_id;
    const result = await runController(updateProject, {
      ...context, params: { id: projectId.toString() }, user, userId: user?._id,
      body: { name: payload.newName || payload.new_name || context.newName },
    });
    const project = result.body?.project || null;
    return {
      executed: result.statusCode < 400, mode: 'command',
      reply: project ? `Project renamed to "${project.name}".` : result.body?.message || 'Project renamed.',
    };
  }

  if (command === 'create_task') {
    const projectId = payload.projectId || payload.project_id || context.projectId || null;
    let panelId     = payload.panelId || payload.panel_id || context.panelId || null;
    if (!panelId && projectId && isObjectId(projectId)) {
      const panels = await Panel.find({ projectId }).sort({ order: 1 });
      const todo   = panels.find(p => /(todo|pending|backlog)/i.test(p.name)) || panels[0];
      panelId      = todo?._id || null;
    }
    const result = await runController(createTask, {
      ...context, user, userId: user?._id,
      body: {
        title:             payload.title || payload.taskName || payload.task_name || context.title,
        description:       payload.description || context.description || '',
        projectId,
        panelId,
        assignedDeveloper: payload.userId || payload.user_id || context.developerId || null,
        priority:          payload.priority || context.priority || 'medium',
        deadline:          payload.deadline || context.deadline || null,
      },
    });
    const task    = result.body?.task || null;
    const projName = payload.projectName || context.projectName || 'the project';
    const assignee = payload.userName || null;
    return {
      executed: result.statusCode < 400, mode: 'command',
      reply: task
        ? assignee
          ? `Task "${task.title}" created in ${projName} and assigned to ${assignee}.`
          : `Task "${task.title}" created in ${projName}.`
        : result.body?.message || 'Task created.',
    };
  }

  if (command === 'delete_task') {
    const taskId = payload.taskId || payload.task_id || context.taskId;
    if (!taskId || !isObjectId(taskId)) return { executed: false, mode: 'command', reply: 'Task not found.' };
    const result = await runController(deleteTask, {
      ...context, params: { id: taskId.toString() }, user, userId: user?._id, body: {},
    });
    return { executed: result.statusCode < 400, mode: 'command', reply: result.body?.message || 'Task deleted.' };
  }

  if (command === 'assign_task') {
    const result = await runController(updateTask, {
      ...context, params: { id: (payload.taskId || payload.task_id || context.taskId || '').toString() },
      user, userId: user?._id,
      body: { assignedDeveloper: payload.userId || payload.user_id || context.developerId },
    });
    const task = result.body?.task || null;
    return { executed: result.statusCode < 400, mode: 'command', reply: task ? `"${formatTaskTitle(task)}" assigned.` : result.body?.message || 'Task assigned.' };
  }

  if (command === 'move_task') {
    const result = await runController(updateTaskStatus, {
      ...context, params: { id: (payload.taskId || payload.task_id || context.taskId || '').toString() },
      user, userId: user?._id,
      body: { status: payload.status || context.status || 'in-progress', panelId: payload.panelId || context.panelId },
    });
    return { executed: result.statusCode < 400, mode: 'command', reply: result.body?.message || 'Task moved.' };
  }

  if (command === 'update_task') {
    const result = await runController(updateTask, {
      ...context, params: { id: (payload.taskId || payload.task_id || context.taskId || '').toString() },
      user, userId: user?._id,
      body: {
        title:       payload.title       || context.title,
        description: payload.description || context.description,
        deadline:    payload.deadline    || context.deadline,
        priority:    payload.priority    || context.priority,
      },
    });
    const task = result.body?.task || null;
    return { executed: result.statusCode < 400, mode: 'command', reply: task ? `"${formatTaskTitle(task)}" updated.` : result.body?.message || 'Task updated.' };
  }

  if (command === 'comment_task') {
    const result = await runController(addTaskComment, {
      ...context, params: { id: (payload.taskId || payload.task_id || context.taskId || '').toString() },
      user, userId: user?._id,
      body: { content: payload.comment || payload.content || payload.text || context.comment || text },
    });
    return { executed: result.statusCode < 400, mode: 'command', reply: result.body?.message || 'Comment added.' };
  }

  if (command === 'update_deadline') {
    const result = await runController(updateTask, {
      ...context, params: { id: (payload.taskId || payload.task_id || context.taskId || '').toString() },
      user, userId: user?._id,
      body: { deadline: payload.deadline || context.deadline },
    });
    return { executed: result.statusCode < 400, mode: 'command', reply: result.body?.message || 'Deadline updated.' };
  }

  return { executed: false, mode: 'command', reply: 'I could not confirm that action.' };
};

// ─────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT — POST /zentrixa/chat
// ─────────────────────────────────────────────────────────────────
export async function handleMessage(req, res) {
  try {
    const { message, text: rawText, context = {} } = req.body || {};
    const text = normalize(message || rawText || '');
    if (!text) return res.status(400).json({ reply: 'Say something and I\'ll help.' });

    const user    = req.user;
    const pending = context.pendingCommand && typeof context.pendingCommand === 'object' ? context.pendingCommand : null;

    // ── Step 1: Python engine classification ──────────────────────
    const classification = await classifyWithPython(text);
    const pyIntent   = classification?.intent?.toLowerCase() || 'unknown';
    const pyRoute    = classification?.route  || 'repeat';
    const pyEntities = classification?.entities || {};
    const pyReply    = classification?.reply   || null;

    // ── Step 2: Global conversation intents — instant response ────
    if (pyIntent === 'global_greeting') {
      const reply = pyReply || `Hello! I'm Zentrixa. How can I help you today?`;
      saveExchange(user._id, text, reply, 'unknown', context);
      return res.json({ executed: true, mode: 'chat', reply, path: 'local' });
    }
    if (pyIntent === 'global_thanks') {
      const reply = pyReply || 'You\'re welcome! Let me know if you need anything.';
      saveExchange(user._id, text, reply, 'unknown', context);
      return res.json({ executed: true, mode: 'chat', reply, path: 'local' });
    }
    if (pyIntent === 'global_goodbye') {
      const reply = pyReply || 'Goodbye! Have a great day.';
      saveExchange(user._id, text, reply, 'unknown', context);
      return res.json({ executed: true, mode: 'chat', reply, path: 'local' });
    }
    if (pyIntent === 'global_cancel' || isNegativeCommand(text)) {
      const reply = 'Cancelled. Let me know if you need anything.';
      saveExchange(user._id, text, reply, 'unknown', context);
      return res.json({ executed: true, mode: 'command', reply, path: 'local' });
    }
    if (pyIntent === 'global_confirm' || isAffirmativeCommand(text)) {
      if (pending?.command || pending?.intent) {
        const result = await executeConfirmedCommand({ user, text, context, payload: pending });
        saveExchange(user._id, text, result.reply, pending?.command || pending?.intent || 'unknown', context);
        return res.json({ ...result, path: 'local' });
      }
      // No recognized pending command — ask again
      const reply = 'What would you like me to do? (I lost track of the pending action — please repeat your command.)';
      saveExchange(user._id, text, reply, 'unknown', context);
      return res.json({ executed: false, mode: 'chat', reply, path: 'local' });
    }
    if (pyIntent === 'global_deny') {
      const reply = pending ? 'No problem! Let me know if you need anything else.' : 'Alright. What can I help you with?';
      saveExchange(user._id, text, reply, 'unknown', context);
      return res.json({ executed: true, mode: 'command', reply, path: 'local' });
    }

    // ── Step 3: Python said REPEAT — gibberish / noise ───────────
    if (pyRoute === 'repeat') {
      const reply = pyReply || 'I didn\'t understand that clearly. Could you please repeat your command?';
      saveExchange(user._id, text, reply, 'unknown', context);
      return res.json({ executed: false, mode: 'chat', reply, path: 'local' });
    }

    // ── Step 4: Command intent — backend handles directly ─────────
    const handler = INTENT_HANDLERS[pyIntent];
    if (handler) {
      const permErr = ensureRole(user, pyIntent);
      if (permErr) return res.json({ executed: false, mode: 'command', reply: permErr, path: 'local' });

      const mergedCtx  = { ...context, ...(pending || {}) };
      const heuristic  = extractEntities(text, pyIntent) || {};
      const merged     = { ...heuristic, ...pyEntities };

      const result = await handler(user, text, merged, mergedCtx);
      saveExchange(user._id, text, result.reply, pyIntent, context);
      return res.json({ ...result, path: 'local', intent: pyIntent });
    }

    // ── Step 5: Unknown intent — LLM only for "?" questions ───────
    const isQuestion = /\?/.test(text) || /\b(what|how|why|when|where|who|can you|could you|tell me|explain)\b/i.test(text);
    if (isQuestion && process.env.OPENAI_API_KEY) {
      const reply = await getOpenAIChatReply({ user, text, context });
      saveExchange(user._id, text, reply, 'unknown', context);
      return res.json({ executed: false, mode: 'chat', reply, path: 'llm' });
    }

    // ── Step 6: Absolute fallback — no LLM ───────────────────────
    const fallback = buildFallbackResponse(user);
    saveExchange(user._id, text, fallback, 'unknown', context);
    return res.json({ executed: false, mode: 'chat', reply: fallback, path: 'local' });

  } catch (error) {
    console.error('[Zentrixa] handleMessage error:', error);
    return res.status(500).json({ executed: false, mode: 'chat', reply: 'I hit a snag. Please try again.' });
  }
}

// ─────────────────────────────────────────────────────────────────
// CONFIRM ENTRY POINT — POST /zentrixa/confirm
// ─────────────────────────────────────────────────────────────────
export async function handleConfirm(req, res) {
  try {
    const { confirmed = false, payload = {}, context = {}, text = '' } = req.body || {};
    const command = normalizeKey(payload.command || payload.intent || payload.action || '');
    if (!command) {
      return res.status(400).json({ executed: false, mode: 'command', reply: 'I could not confirm that action.' });
    }

    const confirmationText = normalize(text) || (confirmed ? 'yes' : 'cancel');
    void saveZentrixaMessage({
      userId: req.user?._id, role: 'user', content: confirmationText, mode: 'command', intent: command,
      projectId: payload.projectId || context.projectId || null,
      taskId:    payload.taskId    || context.taskId    || null,
    });

    if (!confirmed) {
      const reply = 'Okay, no changes made.';
      void saveZentrixaMessage({ userId: req.user?._id, role: 'assistant', content: reply, mode: 'command', intent: command });
      return res.json({ executed: false, mode: 'command', command: command.toUpperCase(), reply, message: reply });
    }

    const result = await executeConfirmedCommand({ user: req.user, text: confirmationText, context, payload });
    void saveZentrixaMessage({
      userId: req.user?._id, role: 'assistant', content: result.reply, mode: 'command', intent: command,
      projectId: payload.projectId || context.projectId || null,
      taskId:    payload.taskId    || context.taskId    || null,
    });
    return res.json({ ...result, command: command.toUpperCase(), message: result.reply, confirmed: true });

  } catch (error) {
    console.error('[Zentrixa] handleConfirm error:', error);
    return res.status(500).json({ executed: false, mode: 'command', reply: 'I hit a snag while confirming that action.' });
  }
}

// ─────────────────────────────────────────────────────────────────
// History & Notifications
// ─────────────────────────────────────────────────────────────────
export async function getZentrixaMessages(req, res) {
  try {
    const limit  = Number(req.query?.limit || 5);
    const cursor = req.query?.cursor || null;
    const { messages, hasMore, nextCursor } = await getZentrixaHistory(req.user?._id, limit, cursor);
    return res.json({
      messages: messages.map(m => ({
        id:        m._id.toString(),
        role:      m.role,
        content:   m.content,
        mode:      m.mode,
        intent:    m.intent,
        projectId: m.projectId?._id?.toString?.() || m.projectId?.toString?.() || null,
        taskId:    m.taskId?._id?.toString?.()    || m.taskId?.toString?.()    || null,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
      hasMore,
      nextCursor,
    });
  } catch (error) {
    console.error('[Zentrixa] History error:', error);
    return res.status(500).json({ message: 'Error fetching Zentrixa history', error: error.message });
  }
}

export async function clearZentrixaNotifications(req, res) {
  try {
    const clearedIds = Array.isArray(req.body?.clearedIds) ? req.body.clearedIds.filter(Boolean) : [];
    const query = { userId: req.user?._id };
    if (clearedIds.length > 0) {
      query._id = { $in: clearedIds };
    } else {
      query.read = false;
    }
    await Notification.updateMany(query, { $set: { read: true } });
    return res.json({ success: true });
  } catch (error) {
    console.error('[Zentrixa] Clear notifications error:', error);
    return res.status(500).json({ message: 'Error clearing notifications' });
  }
}
