/**
 * Centralized Entity Resolver for Zentrixa AI
 * ===========================================
 * Provides unified resolution and cleaning of entity fields (project names,
 * task titles, user names, priorities, statuses) across both Voice and Chat pipelines.
 */

const PROJECT_ALIASES = [
  'project_name',
  'projectName',
  'project',
  'title',
  'name',
  'newName',
  'new_name',
  'workspace',
];

const TASK_ALIASES = [
  'task_name',
  'taskName',
  'title',
  'name',
  'task',
  'ticket',
  'issue',
];

const USER_ALIASES = [
  'user_name',
  'userName',
  'assignee',
  'developer',
  'member',
  'user',
];

const STATUS_ALIASES = [
  'status',
  'taskStatus',
  'state',
];

const PRIORITY_ALIASES = [
  'priority',
  'level',
];

/**
 * Clean entity values by stripping connector phrases, leading articles, filler phrases, and trailing punctuation.
 */
export const cleanEntityValue = (value = '') => {
  if (typeof value !== 'string') return '';
  let cleaned = value.replace(/\s+/g, ' ').trim();

  // Strip connector phrases at start (e.g., "by name of", "named by name of", "called as", "with name")
  const connectorRegex = /^(?:by\s+name\s+of|by\s+the\s+name\s+of|with\s+the\s+name\s+of|under\s+the\s+name\s+of|with\s+name\s+of|name\s+of|which\s+is|name\s+is|named?\s+as|called\s+as|with\s+name|name\s+with|by\s+name|named?|called|titled?|title|with|is|name)\s+/i;

  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned.replace(connectorRegex, '').trim();
    cleaned = cleaned.replace(/^(?:the|a|an|my|this|that)\s+/i, '').trim();
  }

  // Strip voice filler phrases from end
  cleaned = cleaned.replace(
    /\s+(?:at\s+least|at\s+all|please|okay|ok|now|right\s+now|you\s+know|so|then)\s*$/i,
    ''
  );

  // Strip trailing/leading quotes and punctuation
  cleaned = cleaned.replace(/^["'.,!?]+|["'.,!?]+$/g, '').trim();

  return cleaned;
};

/**
 * Resolve a generic field by searching through aliases across entities and context.
 */
export const resolveEntityField = (
  entities = {},
  context = {},
  aliases = [],
  fallback = ''
) => {
  const sources = [entities, context];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const alias of aliases) {
      const val = source[alias];
      if (typeof val === 'string' && val.trim()) {
        const cleaned = cleanEntityValue(val);
        if (cleaned) return cleaned;
      }
    }
  }
  return cleanEntityValue(fallback);
};

/**
 * Resolve project title/name using alias list across entities and context.
 */
export const resolveProjectTitle = (entities = {}, context = {}, text = '') => {
  let resolved = resolveEntityField(entities, context, PROJECT_ALIASES);
  if (!resolved && text) {
    const match = text.match(
      /(?:create|make|start|build)?\s*(?:a\s+|the\s+)?(?:new\s+)?project\s+(?:with\s+name|name\s+with|with|named?|called|titled?|title|is|name)?\s*(.+?)(?:\s+(?:in|for|please|ok|okay|now)\b|$)/i
    );
    if (match?.[1]) {
      resolved = cleanEntityValue(match[1]);
    }
  }
  return resolved;
};

/**
 * Resolve task title/name using alias list across entities and context.
 */
export const resolveTaskTitle = (entities = {}, context = {}, text = '') => {
  let resolved = resolveEntityField(entities, context, TASK_ALIASES);
  if (!resolved && text) {
    const match = text.match(
      /(?:create|add|make|delete|remove|assign|move|update)\s+(?:a\s+|the\s+)?task\s+(.+?)(?:\s+(?:in|for|to|from)\b|$)/i
    );
    if (match?.[1]) {
      resolved = cleanEntityValue(match[1]);
    }
  }
  return resolved;
};

/**
 * Resolve user/developer name using alias list across entities and context.
 */
export const resolveUserName = (entities = {}, context = {}, text = '') => {
  return resolveEntityField(entities, context, USER_ALIASES);
};

/**
 * Resolve task status using alias list.
 */
export const resolveTaskStatus = (entities = {}, context = {}) => {
  return resolveEntityField(entities, context, STATUS_ALIASES);
};

/**
 * Resolve task priority using alias list.
 */
export const resolveTaskPriority = (entities = {}, context = {}) => {
  return resolveEntityField(entities, context, PRIORITY_ALIASES);
};

/**
 * Convenience method to resolve all standard entities into a clean dictionary.
 */
export const resolveAllEntities = (entities = {}, context = {}, text = '') => {
  const project_name = resolveProjectTitle(entities, context, text);
  const task_name    = resolveTaskTitle(entities, context, text);
  const user_name    = resolveUserName(entities, context, text);
  const status       = resolveTaskStatus(entities, context);
  const priority     = resolveTaskPriority(entities, context);

  return {
    ...entities,
    ...(project_name ? { project_name, projectName: project_name, name: project_name, title: project_name } : {}),
    ...(task_name    ? { task_name, taskName: task_name, title: task_name } : {}),
    ...(user_name    ? { user_name, userName: user_name, assignee: user_name } : {}),
    ...(status       ? { status } : {}),
    ...(priority     ? { priority } : {}),
  };
};
