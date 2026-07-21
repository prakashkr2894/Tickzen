import Task from '../models/Task.js';
import Project from '../models/Project.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { emitProjectUpdated } from '../services/realtime.service.js';

const mapUploadedFile = (file) => ({
  filename: file.filename,
  originalName: file.originalname,
  path: file.path,
  mimetype: file.mimetype,
  size: file.size,
  uploadedAt: new Date(),
});

const getTaskAttachments = (task) => {
  if (Array.isArray(task.attachments) && task.attachments.length > 0) {
    return task.attachments;
  }

  if (task.attachmentFile && task.attachmentFile.path) {
    return [task.attachmentFile];
  }

  return [];
};

const deleteStoredFiles = (attachments = []) => {
  attachments.forEach((attachment) => {
    if (attachment?.path && fs.existsSync(attachment.path)) {
      fs.unlinkSync(attachment.path);
    }
  });
};

const mapCommentAuthor = (author, fallbackUser) => ({
  _id: author?._id || fallbackUser?._id || fallbackUser?.id,
  name: author?.name || fallbackUser?.name || `${fallbackUser?.firstName || 'User'} ${fallbackUser?.lastName || ''}`.trim(),
  email: author?.email || fallbackUser?.email || '',
  role: author?.role || fallbackUser?.role || 'developer'
});

const normalizeTaskStatus = (status) => {
  if (status === 'in_progress') return 'in-progress';
  if (status === 'done') return 'completed';
  if (status === 'todo') return 'pending';
  return status;
};

const formatDateForNotification = (date) => {
  if (!date) return 'No due date';
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};

const normalizeMentionKey = (value = '') =>
  value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9._-]+/g, '');

const getUserMentionKeys = (user) => {
  const name = (user?.name || '').trim().toLowerCase();
  const [firstName = '', ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ');
  const emailLocalPart = (user?.email || '').toLowerCase().split('@')[0] || '';

  return new Set([
    normalizeMentionKey(user?.name || ''),
    normalizeMentionKey(emailLocalPart),
    normalizeMentionKey(firstName),
    normalizeMentionKey(lastName),
    normalizeMentionKey(`${firstName}.${lastName}`),
    normalizeMentionKey(`${firstName}_${lastName}`),
    normalizeMentionKey(`${firstName}-${lastName}`),
  ].filter(Boolean));
};

const extractMentionTokens = (content = '') =>
  Array.from(content.matchAll(/@([a-zA-Z0-9._-]+)/g), (match) => normalizeMentionKey(match[1]))
    .filter(Boolean);

const createMentionNotifications = async ({ task, sender, content }) => {
  if (!sender || !content) return;

  const mentionTokens = extractMentionTokens(content);
  if (mentionTokens.length === 0) return;

  const users = await User.find({ role: { $in: ['admin', 'developer'] } }).select('name email role');
  const tokenSet = new Set(mentionTokens);
  const mentionedUsers = users.filter((candidate) => {
    if (!candidate?._id) return false;
    if (candidate._id.toString() === sender._id?.toString()) return false;

    const keys = getUserMentionKeys(candidate);
    for (const token of tokenSet) {
      if (keys.has(token)) return true;
    }
    return false;
  });

  if (mentionedUsers.length === 0) return;

  const notifications = mentionedUsers.map((mentionedUser) => ({
    userId: mentionedUser._id,
    senderId: sender._id,
    taskId: task._id,
    projectId: task.projectId,
    type: 'comment_mentioned',
    title: 'You were mentioned in a comment',
    message: `${sender.name || 'A teammate'} mentioned you on "${task.title}".`,
    read: false
  }));

  await Notification.insertMany(notifications);
};

const createDueDateNotification = async ({ task, sender, previousDeadline, nextDeadline }) => {
  if (!task.assignedDeveloper || !sender) return;
  if (!previousDeadline && !nextDeadline) return;

  const previousValue = previousDeadline ? new Date(previousDeadline).toISOString() : null;
  const nextValue = nextDeadline ? new Date(nextDeadline).toISOString() : null;

  if (previousValue === nextValue) return;

  await Notification.create({
    userId: task.assignedDeveloper,
    senderId: sender._id,
    taskId: task._id,
    projectId: task.projectId,
    type: 'due_date_updated',
    title: 'Task due date updated',
    message: `${task.title} due date changed to ${formatDateForNotification(nextDeadline)}.`,
    read: false
  });
};

const createTaskAssignedNotification = async ({ task, sender }) => {
  if (!task.assignedDeveloper || !sender) return;

  await Notification.create({
    userId: task.assignedDeveloper,
    senderId: sender._id,
    taskId: task._id,
    projectId: task.projectId,
    type: 'task_assigned',
    title: 'New task assigned to you',
    message: `You were assigned to "${task.title}".`,
    read: false
  });
};

// Get tasks by project
export const getTasksByProject = async (req, res) => {
  try {
    const { projectId } = req.params;

    const tasks = await Task.find({ projectId })
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email')
      .sort({ panelId: 1, order: 1, createdAt: 1 });

    res.json({ tasks });
  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({ message: 'Error fetching tasks', error: error.message });
  }
};

// Get tasks assigned to current developer
export const getMyTasks = async (req, res) => {
  try {
    const tasks = await Task.find({ assignedDeveloper: req.userId })
      .populate('projectId', 'name')
      .populate('createdBy', 'name email')
      .sort({ deadline: 1 });

    res.json({ tasks });
  } catch (error) {
    console.error('Get my tasks error:', error);
    res.status(500).json({ message: 'Error fetching tasks', error: error.message });
  }
};

// Get single task
export const getTaskById = async (req, res) => {
  try {
    const { id } = req.params;

    const task = await Task.findById(id)
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email')
      .populate('projectId', 'name');

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    res.json({ task });
  } catch (error) {
    console.error('Get task by ID error:', error);
    res.status(500).json({ message: 'Error fetching task', error: error.message });
  }
};

// Create task (admin only)
export const createTask = async (req, res) => {
  try {
    const { title, description, projectId, panelId, assignedDeveloper, priority, deadline } = req.body;
    const uploadedFiles = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];

    // Check if project exists
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const lastTask = await Task.findOne({ projectId, panelId }).sort({ order: -1, createdAt: -1 });

    const task = new Task({
      title,
      description,
      projectId,
      panelId,
      order: lastTask ? (lastTask.order || 0) + 1 : 0,
      assignedDeveloper,
      createdBy: req.userId,
      status: 'pending',
      priority: priority || 'medium',
      deadline: deadline ? new Date(deadline) : undefined,
      attachments: uploadedFiles.map(mapUploadedFile),
      comments: [],
    });

    if (task.attachments.length > 0) {
      task.attachmentFile = task.attachments[0];
    }

    await task.save();

    await createTaskAssignedNotification({
      task,
      sender: req.user
    });

    // Update project task count and notify all members
    project.totalTasks += 1;
    await project.updateProgress();
    emitProjectUpdated(project);

    const populatedTask = await Task.findById(task._id)
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email');

    res.status(201).json({
      message: 'Task created successfully',
      task: populatedTask
    });
  } catch (error) {
    console.error('Create task error:', error);
    res.status(500).json({ message: 'Error creating task', error: error.message });
  }
};

// Update task (admin only)
export const updateTask = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, assignedDeveloper, priority, deadline, status, panelId, order } = req.body;
    const uploadedFiles = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const previousDeadline = task.deadline ? task.deadline.toISOString() : null;
    const nextDeadline = deadline !== undefined ? (deadline ? new Date(deadline).toISOString() : null) : previousDeadline;

    if (title) task.title = title;
    if (description !== undefined) task.description = description;
    if (assignedDeveloper) task.assignedDeveloper = assignedDeveloper;
    if (priority) task.priority = priority;
    const deadlineChanged = deadline !== undefined && new Date(deadline).toISOString() !== (task.deadline ? task.deadline.toISOString() : null);
    if (deadline !== undefined) task.deadline = deadline ? new Date(deadline) : undefined;
    if (status) task.status = status;
    if (panelId) task.panelId = panelId;
    if (order !== undefined && order !== null && !Number.isNaN(Number(order))) {
      task.order = Number(order);
    }

    // Handle new file attachment
    if (uploadedFiles.length > 0) {
      deleteStoredFiles(getTaskAttachments(task));
      task.attachments = uploadedFiles.map(mapUploadedFile);
      task.attachmentFile = task.attachments[0];
    }

    await task.save();

    if (deadlineChanged && req.user.role === 'admin') {
      await createDueDateNotification({
        task,
        sender: req.user,
        previousDeadline,
        nextDeadline
      });
    }

    const updatedTask = await Task.findById(id)
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email');

    // Notify all project members of the change
    const proj = await Project.findById(task.projectId);
    if (proj) emitProjectUpdated(proj);

    res.json({
      message: 'Task updated successfully',
      task: updatedTask
    });
  } catch (error){
    console.error('Update task error:', error);
    res.status(500).json({ message: 'Error updating task', error: error.message });
  }
};


// Add comment to task
export const addTaskComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'Comment content is required' });
    }

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    task.comments = task.comments || [];
    task.comments.push({
      content: content.trim(),
      author: mapCommentAuthor(req.user, req.user),
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await task.save();

    await createMentionNotifications({
      task,
      sender: req.user,
      content
    });

    const updatedTask = await Task.findById(id)
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email');

    res.status(201).json({
      message: 'Comment added successfully',
      task: updatedTask
    });
  } catch (error) {
    console.error('Add task comment error:', error);
    res.status(500).json({ message: 'Error adding comment', error: error.message });
  }
};

// Mark task as completed by developer
export const completeTask = async (req, res) => {
  try {
    const { id } = req.params;

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user is assigned to this task
    if (task.assignedDeveloper?.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'You are not assigned to this task' });
    }

    task.completedByDeveloper = true;
    task.completedAt = new Date();
    task.status = 'review';

    await task.save();

    const updatedTask = await Task.findById(id)
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email');

    // Notify all project members
    const proj = await Project.findById(task.projectId);
    if (proj) emitProjectUpdated(proj);

    res.json({
      message: 'Task marked as completed. Waiting for admin approval.',
      task: updatedTask
    });
  } catch (error) {
    console.error('Complete task error:', error);
    res.status(500).json({ message: 'Error completing task', error: error.message });
  }
};

// Approve task (admin only)
export const approveTask = async (req, res) => {
  try {
    const { id } = req.params;

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (!task.completedByDeveloper) {
      return res.status(400).json({ message: 'Task has not been marked as completed by developer' });
    }

    task.approvedByAdmin = true;
    task.approvedAt = new Date();
    task.status = 'completed';

    await task.save();

    // Update project progress and notify all members
    const project = await Project.findById(task.projectId);
    if (project) {
      project.completedTasks += 1;
      await project.updateProgress();
      emitProjectUpdated(project);
    }

    const updatedTask = await Task.findById(id)
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email');

    res.json({
      message: 'Task approved successfully',
      task: updatedTask
    });
  } catch (error) {
    console.error('Approve task error:', error);
    res.status(500).json({ message: 'Error approving task', error: error.message });
  }
};

// Reject task completion (admin only) - send back for revisions
export const rejectTask = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    task.completedByDeveloper = false;
    task.completedAt = undefined;
    task.status = 'in-progress';

    await task.save();

    const updatedTask = await Task.findById(id)
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email');

    // Notify all project members
    const proj = await Project.findById(task.projectId);
    if (proj) emitProjectUpdated(proj);

    res.json({
      message: 'Task sent back for revisions',
      task: updatedTask,
      reason
    });
  } catch (error) {
    console.error('Reject task error:', error);
    res.status(500).json({ message: 'Error rejecting task', error: error.message });
  }
};

// Delete task (admin only)
export const deleteTask = async (req, res) => {
  try {
    const { id } = req.params;

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Delete attachment file if exists
    deleteStoredFiles(getTaskAttachments(task));

    // Update project task count and notify all members
    const project = await Project.findById(task.projectId);
    if (project) {
      project.totalTasks = Math.max(0, project.totalTasks - 1);
      if (task.approvedByAdmin) {
        project.completedTasks = Math.max(0, project.completedTasks - 1);
      }
      await project.updateProgress();
      emitProjectUpdated(project);
    }

    await Task.findByIdAndDelete(id);

    res.json({ message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ message: 'Error deleting task', error: error.message });
  }
};

// Download task attachment
export const downloadAttachment = async (req, res) => {
  try {
    const { id } = req.params;

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const attachments = getTaskAttachments(task);

    if (attachments.length === 0) {
      return res.status(404).json({ message: 'No attachment found for this task' });
    }

    const attachment = attachments[0];
    const filePath = attachment.path;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'File not found on server' });
    }

    res.download(filePath, attachment.originalName);
  } catch (error) {
    console.error('Download attachment error:', error);
    res.status(500).json({ message: 'Error downloading attachment', error: error.message });
  }
};

// Update task status
export const updateTaskStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, panelId, order } = req.body;

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }

    const normalizedStatus = normalizeTaskStatus(status);
    const isAdmin = req.user?.role === 'admin';
    const isDeveloperCompletion = !isAdmin && normalizedStatus === 'completed';

    if (panelId) {
      task.panelId = panelId;
    }
    if (order !== undefined && order !== null && !Number.isNaN(Number(order))) {
      task.order = Number(order);
    }

    if (isDeveloperCompletion) {
      task.completedByDeveloper = true;
      task.completedAt = new Date();
      task.status = 'review';
    } else {
      task.status = normalizedStatus;
      if (normalizedStatus === 'completed' && isAdmin) {
        task.approvedByAdmin = true;
        task.approvedAt = new Date();
      }
      if (normalizedStatus !== 'completed') {
        task.completedByDeveloper = false;
        task.completedAt = undefined;
        task.approvedByAdmin = false;
        task.approvedAt = undefined;
      }
    }
    await task.save();

    const updatedTask = await Task.findById(id)
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email');

    res.json({
      message: isDeveloperCompletion
        ? 'Task marked as completed. Waiting for admin approval.'
        : 'Task status updated',
      task: updatedTask
    });
  } catch (error) {
    console.error('Update task status error:', error);
    res.status(500).json({ message: 'Error updating task status', error: error.message });
  }
};
