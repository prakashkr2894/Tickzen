import express from 'express';
import { classifyIntent } from '../services/zentrixa.service.js';
import { extractEntities } from '../utils/entityExtractor.js';
import {
  clearZentrixaNotifications,
  getZentrixaMessages,
  handleZentrixaMessage,
  handleZentrixaConfirm,
} from '../services/zentrixa-chat.service.js';
import {
  createProject,
  inviteDeveloper,
} from '../controllers/project.controller.js';
import {
  createTask,
  deleteTask,
  updateTask,
  updateTaskStatus,
} from '../controllers/task.controller.js';
import {
  createPanel,
} from '../controllers/panel.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import Project from '../models/Project.js';
import Panel from '../models/Panel.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import fs from 'fs';
import {
  escapeRegExp,
  normalize as normalizeWhitespace,
  buildRegex,
  createMockRes,
  runController,
} from '../utils/zentrixa-helpers.js';

const upload = multer({ dest: 'uploads/' });
const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'text is required' });
    }

    const result = await classifyIntent(text);
    return res.json(result);
  } catch (error) {
    console.error('Zentrixa AI route error:', error);
    return res.status(500).json({
      message: 'Failed to classify intent',
      error: error.message
    });
  }
});

router.use(authenticate);

router.post('/chat', handleZentrixaMessage);
router.post('/message', handleZentrixaMessage);
router.post('/confirm', handleZentrixaConfirm);
router.get('/messages', getZentrixaMessages);
router.delete('/notifications', clearZentrixaNotifications);

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const client = new AssemblyAI({
      apiKey: process.env.ASSEMBLYAI_API_KEY
    });

    const filePath = req.file.path + '.webm';
    fs.renameSync(req.file.path, filePath);

    const transcript = await client.transcripts.transcribe({
      audio: filePath,
      speech_models: ["universal-2"]
    });

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    if (transcript.error) {
      return res.status(500).json({ error: transcript.error });
    }

    return res.json({ text: transcript.text || "" });
  } catch (error) {
    console.error('Transcription error:', error);
    const filePath = req.file ? req.file.path + '.webm' : null;
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: error.message });
  }
});

const extractTaskTitleHint = (text = '') => {
  const normalized = normalizeWhitespace(text.toLowerCase());
  const patterns = [
    /(?:delete|remove|cancel|trash|erase)\s+(?:the\s+)?task\s+(.+?)(?:\s+from\b|\s+in\b|\s+of\b|\s+on\b|$)/i,
    /(?:delete|remove|cancel|trash|erase)\s+(.+?)(?:\s+from\b|\s+in\b|\s+of\b|\s+on\b|$)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1]
        .replace(/\b(task|project|board|card)\b/gi, '')
        .replace(/\b(my|this|that|the|a|an)\b/gi, '')
        .trim();
    }
  }

  return '';
};

const buildTaskCandidateResponse = ({ text, confidence, candidates, message, taskId }) => ({
  intent: 'delete_task',
  executed: false,
  requiresConfirmation: true,
  confirmationType: 'delete_task',
  taskId: taskId || null,
  candidates,
  message,
  confidence,
  text,
});

const mapTaskCandidate = (task) => ({
  id: task._id,
  title: task.title,
  projectName: task.projectId?.name || '',
  status: task.status,
});

const resolveProjectByName = async (projectName) => {
  if (!projectName) return null;
  return Project.findOne({ name: buildRegex(projectName) });
};

const resolveUserByName = async (userName) => {
  if (!userName) return null;
  return User.findOne({ name: buildRegex(userName) }).select('_id name email role');
};

const resolveTasksByName = async ({ taskName, projectId }) => {
  const query = {};
  if (taskName) query.title = buildRegex(taskName);
  if (projectId) query.projectId = projectId;
  if (Object.keys(query).length === 0) return [];
  return Task.find(query)
    .populate('projectId', 'name')
    .populate('assignedDeveloper', 'name email')
    .limit(10)
    .sort({ updatedAt: -1 });
};

const resolveTodoPanelId = async (projectId) => {
  if (!projectId) return null;
  const panels = await Panel.find({ projectId }).sort({ order: 1 });
  if (panels.length === 0) return null;
  const todoPanel = panels.find((panel) =>
    /(^|\b)(to\s*do|todo|pending|backlog)(\b|$)/i.test(panel.name)
  );
  return (todoPanel || panels[0])._id;
};


router.post('/dispatch', async (req, res) => {
  try {
    const {
      action,
      intent: legacyIntent,
      text,
      context = {},
      confidence,
      entities = {},
      projectId,
      taskId,
      developerId,
      panelId,
      status,
      deadline,
      payload = {},
    } = req.body || {};
    const commandType = action || legacyIntent;
    const intent = commandType;

    if (!commandType) {
      return res.status(400).json({
        intent: 'unknown',
        executed: false,
        message: 'intent is required',
      });
    }

    const extractedEntities = {
      ...extractEntities(text || '', commandType),
      ...entities,
    };
    const body = { ...payload, ...context, entities: extractedEntities };
    const targetProjectId = projectId || context.projectId;
    const targetTaskId = taskId || context.taskId;
    const isAdmin = req.user?.role === 'admin';
    const taskName = extractedEntities.task_name;
    const projectName = extractedEntities.project_name;
    const panelName = extractedEntities.panel_name || taskName;
    const userName = extractedEntities.user_name;
    const statusName = extractedEntities.status;

    let resolvedProject = null;
    let resolvedUser = null;
    let matchedTasks = [];

    if (projectName) {
      resolvedProject = await resolveProjectByName(projectName);
    }

    if (userName && !developerId) {
      resolvedUser = await resolveUserByName(userName);
    }

    if (commandType === 'show_delayed') {
      const delayedTasks = await Task.find({
        deadline: { $lt: new Date() },
        status: { $nin: ['completed', 'done'] },
      })
        .populate('assignedDeveloper', 'name email')
        .populate('createdBy', 'name email')
        .populate('projectId', 'name')
        .sort({ deadline: 1 });

      return res.json({
        intent,
        executed: true,
        message: `Found ${delayedTasks.length} delayed task(s).`,
        data: delayedTasks,
        confidence,
        text,
      });
    }

    if (commandType === 'analyze_project') {
      if (!targetProjectId) {
        return res.json({
          intent,
          executed: false,
          message: 'projectId is required for project analysis.',
          missing: ['projectId'],
          confidence,
          text,
        });
      }

      const project = await Project.findById(targetProjectId)
        .populate('developers', 'name email')
        .populate('createdBy', 'name email')
        .populate('panels');
      const tasks = await Task.find({ projectId: targetProjectId });

      if (!project) {
        return res.status(404).json({
          intent,
          executed: false,
          message: 'Project not found',
          confidence,
          text,
        });
      }

      return res.json({
        intent,
        executed: true,
        message: 'Project analysis generated.',
        data: {
          project,
          stats: {
            total: tasks.length,
            completed: tasks.filter((task) => task.approvedByAdmin || task.status === 'completed').length,
            pending: tasks.filter((task) => !task.completedByDeveloper).length,
            inReview: tasks.filter((task) => task.completedByDeveloper && !task.approvedByAdmin).length,
          },
        },
        confidence,
        text,
      });
    }

    if (commandType === 'create_with_ai') {
      return res.json({
        intent,
        executed: false,
        message: 'AI project generation should be handled by your project generator flow.',
        confidence,
        text,
      });
    }

    if (commandType === 'create_project') {
      if (!isAdmin) {
        return res.status(403).json({
          intent,
          executed: false,
          message: 'Admin role required to create a project.',
          confidence,
          text,
        });
      }

      const controllerReq = {
        ...req,
        body: {
          ...body,
          name: body.name || projectName || text,
        },
      };
      const result = await runController(createProject, controllerReq);
      return res.status(result.statusCode).json({
        intent,
        executed: true,
        confidence,
        text,
        data: result.body,
      });
    }

    if (commandType === 'create_panel') {
      if (!isAdmin) {
        return res.status(403).json({
          intent,
          executed: false,
          message: 'Admin role required to create a panel.',
          confidence,
          text,
        });
      }

      if (!resolvedProject && !targetProjectId) {
        return res.json({
          intent,
          executed: false,
          message: 'projectId or project_name is required to create a panel.',
          missing: ['projectId'],
          confidence,
          text,
          entities: extractedEntities,
        });
      }

      const controllerReq = {
        ...req,
        body: {
          ...body,
          name: body.name || panelName || text,
          projectId: body.projectId || targetProjectId || resolvedProject?._id,
          description: body.description || '',
          color: body.color || '#007bff',
        },
      };

      const result = await runController(createPanel, controllerReq);
      if (result.statusCode >= 400) {
        return res.status(result.statusCode).json({
          intent,
          executed: false,
          confidence,
          text,
          message: result.body?.message || 'Failed to create panel.',
          data: result.body,
          entities: extractedEntities,
        });
      }

      return res.status(result.statusCode).json({
        intent,
        executed: true,
        confidence,
        text,
        message: `Panel "${controllerReq.body.name}" created in ${projectName || 'the project'}.`,
        data: result.body,
        entities: extractedEntities,
      });
    }

    if (commandType === 'create_task') {
      if (!isAdmin) {
        return res.status(403).json({
          intent,
          executed: false,
          message: 'Admin role required to create a task.',
          confidence,
          text,
        });
      }

      if (projectName && !resolvedProject) {
        return res.status(404).json({
          intent,
          executed: false,
          message: `Project "${projectName}" was not found.`,
          missing: ['project_name'],
          confidence,
          text,
          entities: extractedEntities,
        });
      }

      const effectiveProjectId = projectName
        ? resolvedProject?._id
        : targetProjectId || resolvedProject?._id;
      const effectivePanelId = body.panelId || (await resolveTodoPanelId(effectiveProjectId));

      const controllerReq = {
        ...req,
        body: {
          ...body,
          title: body.title || taskName || text,
          projectId: body.projectId || effectiveProjectId,
          panelId: effectivePanelId || body.panelId,
          assignedDeveloper: body.assignedDeveloper || resolvedUser?._id,
          status: 'pending',
        },
      };
      if (!controllerReq.body.projectId) {
        return res.json({
          intent,
          executed: false,
          message: 'projectId or project_name is required to create a task.',
          missing: ['projectId'],
          confidence,
          text,
          entities: extractedEntities,
        });
      }
      const result = await runController(createTask, controllerReq);
      const createdTask = result.body?.task || null;
      const createdTaskName = createdTask?.title || controllerReq.body.title;
      const projectLabel = createdTask?.projectId?.name || projectName || 'your workspace';

      if (result.statusCode >= 400) {
        return res.status(result.statusCode).json({
          intent,
          executed: false,
          confidence,
          text,
          message: result.body?.message || 'Failed to create task.',
          data: result.body,
          entities: extractedEntities,
        });
      }

      return res.status(result.statusCode).json({
        intent,
        executed: true,
        confidence,
        text,
        message: `Task "${createdTaskName}" created in ${projectLabel}. Status: To Do.`,
        data: createdTask || result.body,
        task: createdTask,
        projectId: controllerReq.body.projectId?.toString?.() || controllerReq.body.projectId,
        panelId: controllerReq.body.panelId?.toString?.() || controllerReq.body.panelId,
        nextPrompt: `Would you like to add more people to "${createdTaskName}"?`,
        entities: extractedEntities,
      });
    }

    if (commandType === 'assign_task') {
      if (!isAdmin) {
        return res.status(403).json({
          intent,
          executed: false,
          message: 'Admin role required to assign a task.',
          confidence,
          text,
        });
      }

      if (!targetTaskId && !taskName) {
        return res.json({
          intent,
          executed: false,
          message: 'taskId or task_name is required to assign a task.',
          missing: ['taskId'],
          confidence,
          text,
        });
      }

      if (!developerId && !resolvedUser?._id) {
        return res.json({
          intent,
          executed: false,
          message: 'developerId or user_name is required to assign a task.',
          missing: ['developerId'],
          confidence,
          text,
          entities: extractedEntities,
        });
      }

      matchedTasks = await resolveTasksByName({
        taskName,
        projectId: targetProjectId || resolvedProject?._id,
      });
      const selectedTask = targetTaskId
        ? await Task.findById(targetTaskId)
        : matchedTasks[0];

      if (!selectedTask) {
        return res.json({
          intent,
          executed: false,
          message: taskName
            ? `I could not find a task matching "${taskName}".`
            : 'I need a task name before assigning it.',
          candidates: matchedTasks.map((task) => ({
            id: task._id,
            title: task.title,
            projectName: task.projectId?.name || '',
            status: task.status,
          })),
          confidence,
          text,
          entities: extractedEntities,
        });
      }

      const controllerReq = {
        ...req,
        params: { ...req.params, id: selectedTask._id.toString() },
        body: {
          ...body,
          assignedDeveloper: developerId || resolvedUser?._id,
        },
      };
      const result = await runController(updateTask, controllerReq);
      return res.status(result.statusCode).json({
        intent,
        executed: true,
        confidence,
        text,
        data: result.body,
      });
    }

    if (commandType === 'move_task') {
      if (!targetTaskId && !taskName) {
        return res.json({
          intent,
          executed: false,
          message: 'taskId or task_name is required to move a task.',
          missing: ['taskId'],
          confidence,
          text,
        });
      }

      matchedTasks = await resolveTasksByName({
        taskName,
        projectId: targetProjectId || resolvedProject?._id,
      });
      const selectedTask = targetTaskId
        ? await Task.findById(targetTaskId)
        : matchedTasks[0];

      if (!selectedTask) {
        return res.json({
          intent,
          executed: false,
          message: taskName
            ? `I could not find a task matching "${taskName}".`
            : 'I need a task name before moving it.',
          candidates: matchedTasks.map((task) => ({
            id: task._id,
            title: task.title,
            projectName: task.projectId?.name || '',
            status: task.status,
          })),
          confidence,
          text,
          entities: extractedEntities,
        });
      }

      const controllerReq = {
        ...req,
        params: { ...req.params, id: selectedTask._id.toString() },
        body: {
          ...body,
          status: statusName || status || body.status,
          panelId: panelId || body.panelId,
        },
      };
      const result = await runController(updateTaskStatus, controllerReq);
      return res.status(result.statusCode).json({
        intent,
        executed: true,
        confidence,
        text,
        data: result.body,
      });
    }

    if (commandType === 'delete_task') {
      if (!isAdmin) {
        return res.status(403).json({
          intent,
          executed: false,
          message: 'Admin role required to delete a task.',
          confidence,
          text,
        });
      }

      const taskTitleHint = taskName || extractTaskTitleHint(text);
      const searchProjectId = targetProjectId || resolvedProject?._id;
      let candidateTasks = [];

      if (targetTaskId) {
        const selectedTask = await Task.findById(targetTaskId)
          .populate('projectId', 'name')
          .populate('assignedDeveloper', 'name email');
        if (selectedTask) {
          candidateTasks = [selectedTask];
        }
      } else if (taskTitleHint) {
        candidateTasks = await resolveTasksByName({
          taskName: taskTitleHint,
          projectId: searchProjectId,
        });
      }

      if (!req.body?.confirmed) {
        if (candidateTasks.length === 0) {
          return res.json(
            buildTaskCandidateResponse({
              text,
              confidence,
              candidates: [],
              message: taskTitleHint
                ? `I could not find a task matching "${taskTitleHint}".`
                : 'I need the exact task name before deleting it.',
            })
          );
        }

        if (candidateTasks.length === 1) {
          const task = candidateTasks[0];
          return res.json(
            buildTaskCandidateResponse({
              text,
              confidence,
              taskId: task._id.toString(),
              candidates: [mapTaskCandidate(task)],
              message: `I found "${task.title}" in ${task.projectId?.name || 'your workspace'}. Confirm delete to continue.`,
            })
          );
        }

        return res.json(
          buildTaskCandidateResponse({
            text,
            confidence,
            candidates: candidateTasks.map(mapTaskCandidate),
            message: 'I found multiple matching tasks. Please choose one or add more detail.',
          })
        );
      }

      const confirmedTaskId = targetTaskId || candidateTasks[0]?._id;
      if (!confirmedTaskId) {
        return res.json({
          intent,
          executed: false,
          message: 'taskId is required to delete a task.',
          missing: ['taskId'],
          confidence,
          text,
        });
      }

      const controllerReq = {
        ...req,
        params: { ...req.params, id: confirmedTaskId.toString() },
      };
      const result = await runController(deleteTask, controllerReq);
      return res.status(result.statusCode).json({
        intent,
        executed: true,
        confidence,
        text,
        data: result.body,
      });
    }

    if (commandType === 'update_deadline') {
      if (!isAdmin) {
        return res.status(403).json({
          intent,
          executed: false,
          message: 'Admin role required to update a deadline.',
          confidence,
          text,
        });
      }

      if (!targetTaskId) {
        return res.json({
          intent,
          executed: false,
          message: 'taskId is required to update a deadline.',
          missing: ['taskId'],
          confidence,
          text,
        });
      }

      const controllerReq = {
        ...req,
        params: { ...req.params, id: targetTaskId },
        body: {
          ...body,
          deadline: deadline || body.deadline,
        },
      };
      const result = await runController(updateTask, controllerReq);
      return res.status(result.statusCode).json({
        intent,
        executed: true,
        confidence,
        text,
        data: result.body,
      });
    }

    if (commandType === 'add_member') {
      if (!isAdmin) {
        return res.status(403).json({
          intent,
          executed: false,
          message: 'Admin role required to add a member.',
          confidence,
          text,
        });
      }

      if (!targetProjectId || !developerId) {
        return res.json({
          intent,
          executed: false,
          message: 'projectId and developerId are required to add a member.',
          missing: ['projectId', 'developerId'],
          confidence,
          text,
        });
      }

      const controllerReq = {
        ...req,
        params: { ...req.params, id: targetProjectId },
        body: {
          developerId,
          message: body.message || `You have been invited to join the project.`,
        },
      };
      const result = await runController(inviteDeveloper, controllerReq);
      return res.status(result.statusCode).json({
        intent,
        executed: true,
        confidence,
        text,
        data: result.body,
      });
    }

    return res.status(400).json({
      intent: commandType,
      executed: false,
      message: `Unsupported intent: ${commandType}`,
      confidence,
      text,
    });
  } catch (error) {
    console.error('Zentrixa dispatch error:', error);
    return res.status(500).json({
      intent: req.body?.action || req.body?.intent || 'unknown',
      executed: false,
      message: 'Failed to dispatch intent',
      error: error.message,
    });
  }
});

/**
 * GET /zentrixa/actions
 * Returns the canonical list of backend-supported actions.
 * Used by the frontend voice-action system to validate intent matches.
 */
router.get('/actions', (_req, res) => {
  res.json([
    'create_project',
    'delete_project',
    'rename_project',
    'analyze_project',
    'create_task',
    'delete_task',
    'assign_task',
    'move_task',
    'update_task',
    'comment_task',
    'show_delayed',
    'add_member',
    'remove_member',
    'update_deadline',
    'create_panel',
  ]);
});

export default router;
