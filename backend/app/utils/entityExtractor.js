const STATUS_ALIASES = {
  todo: "pending",
  "to do": "pending",
  pending: "pending",
  "in progress": "in-progress",
  progress: "in-progress",
  doing: "in-progress",
  review: "review",
  done: "completed",
  completed: "completed",
  complete: "completed",
};

const clean = (value = "") => value.replace(/\s+/g, " ").trim().replace(/^["'.,!?]+|["'.,!?]+$/g, "");

const stripLeadingTokens = (value = "") =>
  clean(value).replace(/^(the|a|an|my|this|that)\s+/i, "").trim();

// Strip "name/named/called/titled/and name it" label that appears between "project" and actual name
const stripLeadingLabel = (value = "") =>
  clean(value).replace(/^(?:and\s+name\s+it|and\s+call\s+it|and\s+title\s+it|with\s+name|name\s+with|which\s+is\s+named|that\s+is\s+called|named?|called|titled?|title|is|name|with)\s+/i, "").trim();

// Strip common voice filler phrases from the end of a captured name
const stripVoiceFillers = (value = "") =>
  value
    .replace(/\s+(at\s+least|at\s+all|please|okay|ok|now|right\s+now|you\s+know|so|then)\s*$/i, "")
    .trim();

const takeUntil = (value = "", stopWords = []) => {
  if (!value) return "";
  const pattern = new RegExp(`\\b(?:${stopWords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  return clean(value.split(pattern)[0] || value);
};

const findStatus = (text = "") => {
  const normalized = clean(text).toLowerCase();

  const ordered = Object.entries(STATUS_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, mapped] of ordered) {
    const pattern = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(normalized)) {
      return mapped;
    }
  }

  return null;
};

const extractWithPatterns = (text, patterns) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return clean(match[1]);
    }
  }
  return "";
};

export function extractEntities(text = "", intent = "unknown") {
  const normalized = clean(text);
  const entities = {};

  // ── create_project: extract project name using modular pattern groups ──
  if (intent === "create_project") {
    const VERB_ACTIONS = "(?:create|make|add|start|new|build|open|launch|setup|set\\s+up|initiate)";
    const WANT_PHRASES = "(?:i(?:'d|\\s+would|\\s+want|\\s+need)\\s+(?:like\\s+)?to\\s+(?:create|make|add|start|build)?\\s*|(?:i(?:'d|\\s+would)\\s+like\\s+)?|(?:can|could|please)\\s+(?:you\\s+)?(?:create|make|add|start|build)?\\s*)";
    const PROJECT_NOUNS = "(?:project|workspace|repository|repo)";
    const CONNECTORS = "(?:\\s+(?:and\\s+name\\s+it|and\\s+call\\s+it|and\\s+title\\s+it|with\\s+name|name\\s+with|which\\s+is\\s+named|that\\s+is\\s+called|named?|called|titled?|title|is|name|with))\\s+";
    const DELIMITERS = "(?:\\s+(?:in|for|with|assigned|by|on|at|due|priority|status|please|ok|okay|now)\\b|$)";

    const createProjectPatterns = [
      new RegExp(`\\b(?:${VERB_ACTIONS}|${WANT_PHRASES})\\s*(?:a\\s+|the\\s+)?(?:new\\s+)?${PROJECT_NOUNS}${CONNECTORS}(.+?)${DELIMITERS}`, "i"),
      new RegExp(`\\b(?:${VERB_ACTIONS}|${WANT_PHRASES})\\s*(?:a\\s+|the\\s+)?(?:new\\s+)?${PROJECT_NOUNS}\\s+(.+?)${DELIMITERS}`, "i"),
      new RegExp(`\\b${PROJECT_NOUNS}${CONNECTORS}(.+?)${DELIMITERS}`, "i"),
      new RegExp(`\\b${PROJECT_NOUNS}\\s+(.+?)${DELIMITERS}`, "i"),
    ];

    for (const pattern of createProjectPatterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
        const raw = stripLeadingLabel(clean(match[1]));
        const withoutFillers = stripVoiceFillers(raw);
        const name = stripLeadingTokens(takeUntil(withoutFillers, ["in", "for", "with", "and", "by", "on", "at", "of"]));
        if (name && !["project", "workspace", "name", "it", "repo"].includes(name.toLowerCase())) {
          entities.project_name = name;
          break;
        }
      }
    }
  }

  const taskPatterns = [
    /(?:delete|remove|cancel|trash|erase|assign|move|update|create|rename|retitle)\s+(?:the\s+)?task\s+(.+?)(?:\s+from\b|\s+to\b|\s+in\b|\s+of\b|\s+on\b|$)/i,
    /(?:delete|remove|cancel|trash|erase)\s+(.+?)(?:\s+from\b|\s+in\b|\s+of\b|\s+on\b|$)/i,
    /(?:assign|move|update|create|rename|retitle)\s+(.+?)(?:\s+to\b|\s+from\b|\s+in\b|\s+of\b|\s+on\b|$)/i,
  ];

  const projectPatterns = [
    /\bfrom\s+project\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)/i,
    /\bfrom\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)/i,
    /\bproject\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)/i,
  ];

  const userPatterns = [
    /\bto\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$/i,
    /\bassign(?:ed)?\s+(?:to\s+)?([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$/i,
    /\bfor\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$/i,
  ];

  const statusPatterns = [
    /\bmove\s+task\s+.+?\s+to\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)$/i,
    /\bto\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)$/i,
    /\bstatus\s+is\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)$/i,
  ];

  if (["delete_task", "assign_task", "move_task", "update_deadline", "create_task", "update_task"].includes(intent)) {
    const taskName = extractWithPatterns(normalized, taskPatterns);
    if (taskName) {
      entities.task_name = stripLeadingTokens(takeUntil(taskName, ["from", "to", "in", "of", "on"]));
    }
  }

  if (["delete_task", "assign_task", "create_task", "analyze_project", "add_member"].includes(intent)) {
    const projectName = extractWithPatterns(normalized, projectPatterns);
    if (projectName) {
      entities.project_name = stripLeadingTokens(takeUntil(projectName, ["to", "by", "for", "task"]));
    }
  }

  if (intent === "create_task") {
    const projectMatch = normalized.match(/\bin\s+(?:the\s+)?(.+?)(?:\s+and\b|\s+assign\b|\s+to\b|\s+for\b|$)/i);
    if (projectMatch?.[1]) {
      const projectValue = stripLeadingTokens(takeUntil(projectMatch[1], ["and", "assign", "to", "for"]));
      entities.project_name = projectValue.replace(/^(project|workspace|board)\s+/i, "").trim();
    }

    const emailMatch = normalized.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
    if (emailMatch?.[1]) {
      entities.user_name = emailMatch[1];
    }

    const assigneeMatch = normalized.match(/\bassign(?:ed)?\s+(?:to\s+)?(.+?)(?:\s+and\b|\s+in\b|\s+for\b|$)/i);
    if (assigneeMatch?.[1]) {
      const cleaned = stripLeadingTokens(clean(assigneeMatch[1]));
      if (cleaned) {
        entities.user_name = cleaned;
      }
    }
  }

  if (["assign_task", "add_member"].includes(intent)) {
    const userName = extractWithPatterns(normalized, userPatterns);
    if (userName) {
      const cleaned = stripLeadingTokens(userName);
      if (cleaned && !["task", "project", "done", "review"].includes(cleaned.toLowerCase())) {
        entities.user_name = cleaned;
      }
    }
  }

  if (intent === "add_member") {
    const emailMatch = normalized.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
    const existingUserName = entities.user_name || "";
    const existingProjectName = entities.project_name || "";
    if (emailMatch?.[1]) {
      entities.user_name = emailMatch[1];
    }

    const directPatterns = [
      /(?:add|invite|assign)\s+(?:the\s+)?(.+?)\s+(?:to|into)\s+(?:the\s+)?(.+?)\s+project\b/i,
      /(?:project|workspace)\s+(?:is\s+)?(.+?)(?:\s+and\b|\s+with\b|\s+for\b|$)/i,
      /(?:person|user|member)\s+(?:is\s+)?(.+?)(?:\s+and\b|\s+with\b|\s+for\b|$)/i,
      /(?:to|in)\s+(?:the\s+)?(.+?)\s+project\b/i,
    ];

    for (const pattern of directPatterns) {
      const match = normalized.match(pattern);
      if (!match) continue;

      if (pattern === directPatterns[0]) {
        const maybeUser = stripLeadingTokens(clean(match[1]));
        const maybeProject = stripLeadingTokens(clean(match[2]));
        if (maybeUser && (!entities.user_name || /(?:project|workspace|team)\b/i.test(existingUserName))) {
          entities.user_name = maybeUser;
        }
        if (maybeProject && (!entities.project_name || /(?:person|user|member)\b/i.test(existingProjectName))) {
          entities.project_name = maybeProject;
        }
        break;
      }

      if (pattern === directPatterns[1]) {
        const maybeProject = stripLeadingTokens(clean(match[1]));
        if (maybeProject && (!entities.project_name || /(?:person|user|member)\b/i.test(existingProjectName))) {
          entities.project_name = maybeProject;
        }
        continue;
      }

      if (pattern === directPatterns[2]) {
        const maybeUser = stripLeadingTokens(clean(match[1]));
        if (maybeUser && (!entities.user_name || /(?:project|workspace|team)\b/i.test(existingUserName))) {
          entities.user_name = maybeUser;
        }
        continue;
      }

      if (pattern === directPatterns[3]) {
        const maybeProject = stripLeadingTokens(clean(match[1]));
        if (maybeProject && (!entities.project_name || /(?:person|user|member)\b/i.test(existingProjectName))) {
          entities.project_name = maybeProject;
        }
      }
    }

    if (entities.project_name) {
      entities.project_name = entities.project_name
        .replace(/\b(project|workspace|team)\b$/i, "")
        .replace(/^(the|a|an)\s+/i, "")
        .trim();
    }
  }

  if (["move_task", "update_deadline"].includes(intent)) {
    const statusText = extractWithPatterns(normalized, statusPatterns);
    if (statusText) {
      entities.status = findStatus(statusText) || clean(statusText).toLowerCase();
    } else {
      const status = findStatus(normalized);
      if (status) {
        entities.status = status;
      }
    }
  }

  if (intent === "create_task" && !entities.task_name) {
    const match = normalized.match(/(?:create|add|make)\s+(?:a\s+)?task\s+(.+?)(?:\s+for\b|\s+in\b|\s+to\b|$)/i);
    if (match?.[1]) {
      entities.task_name = stripLeadingTokens(takeUntil(match[1], ["for", "in", "to"]));
    }
  }

  if (intent === "update_task") {
    const renamePatterns = [
      /(?:rename|retitle|change\s+name|name\s+it)\s+(?:the\s+)?task\s+(.+?)(?:\s+to\b|\s+as\b|\s+into\b|$)/i,
      /\bor\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)\s+(?:rkh|rk|rakh)\s*do\b/i,
      /(?:to|as|into)\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$/i,
    ];

    for (const pattern of renamePatterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
        entities.new_name = stripLeadingTokens(clean(match[1]));
        break;
      }
    }
  }

  return entities;
}
