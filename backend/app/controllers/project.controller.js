import mongoose from 'mongoose';
import Project from '../models/Project.js';
import Panel from '../models/Panel.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import ProjectRequest from '../models/ProjectRequest.js';
import { emitToUser, emitProjectUpdated } from '../services/realtime.service.js';

// Get all projects for the current user
export const getProjects = async (req, res) => {
  try {
    const filter = req.user.role === 'admin'
      ? { $or: [{ createdBy: req.userId }, { admins: req.userId }] }
      : { developers: req.userId };

    const projects = await Project.find(filter)
      .populate('developers', 'name email')
      .populate('admins', 'name email')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ projects });
  } catch (error) {
    console.error('Get projects error:', error);
    res.status(500).json({ message: 'Error fetching projects', error: error.message });
  }
};

// Get all projects (for admin sidebar)
export const getAllProjects = async (req, res) => {
  try {
    const projects = await Project.find()
      .populate('developers', 'name email')
      .populate('admins', 'name email')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ projects });
  } catch (error) {
    console.error('Get all projects error:', error);
    res.status(500).json({ message: 'Error fetching all projects', error: error.message });
  }
};

/**
 * GET /api/projects/dashboard
 * Returns all projects with their panels and tasks in a single query.
 * Replaces the N+1 waterfall (1 project fetch + 2 per project = 2N+1 requests)
 * with a single aggregated response.
 */
export const getDashboard = async (req, res) => {
  try {
    const filter = req.user.role === 'admin'
      ? { $or: [{ createdBy: req.userId }, { admins: req.userId }] }
      : { developers: req.userId };

    const [projects, requests] = await Promise.all([
      Project.find(filter)
        .populate('developers', 'name email role avatar')
        .populate('admins', 'name email role')
        .populate('createdBy', 'name email role')
        .populate('panels')
        .lean(),
      ProjectRequest.find({ developerId: req.userId, status: 'pending' })
        .populate('projectId', 'name description')
        .populate('senderId', 'name email')
        .lean(),
    ]);

    const projectIds = projects.map(p => p._id);
    const tasks = await Task.find({ projectId: { $in: projectIds } })
      .populate('assignedDeveloper', 'name email')
      .populate('createdBy', 'name email')
      .lean();

    // Group tasks by projectId in a single O(n) pass
    const tasksByProject = {};
    for (const task of tasks) {
      if (task.projectId) {
        const key = task.projectId.toString();
        (tasksByProject[key] ||= []).push(task);
      }
    }

    const enrichedProjects = projects.map(p => ({
      ...p,
      tasks: tasksByProject[p._id.toString()] || [],
    }));

    res.json({ projects: enrichedProjects, requests });
  } catch (error) {
    console.error('Get dashboard error:', error);
    res.status(500).json({ message: 'Error fetching dashboard data', error: error.message });
  }
};

// Create new project (admin only)
export const createProject = async (req, res) => {
  try {
    const { name, description, panels, githubRepository } = req.body;
    const normalizedName = (name || '').trim().toLowerCase();
    if (!normalizedName) {
      return res.status(400).json({ message: 'Project name is required' });
    }

    const existingProject = await Project.findOne({
      name: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      createdBy: req.userId,
    });
    if (existingProject) {
      return res.status(409).json({ message: `Project "${existingProject.name}" already exists.` });
    }

    const defaultPanels = [
      { name: 'To Do', description: 'Tasks waiting to be started', color: '#64748b' },
      { name: 'In Progress', description: 'Tasks currently being worked on', color: '#2563eb' },
      { name: 'Done', description: 'Completed tasks', color: '#16a34a' },
    ];
    const panelsToCreate = Array.isArray(panels) && panels.length > 0 ? panels : defaultPanels;

    const project = new Project({
      name,
      description,
      githubRepository: githubRepository || '',
      createdBy: req.userId
    });

    // Create panels first, then save project once with panel IDs (atomic single save)
    const panelDocs = await Panel.insertMany(
      panelsToCreate.map((panel, index) => ({
        name: panel.name,
        projectId: project._id,
        description: panel.description || '',
        order: index,
        color: panel.color || '#007bff'
      }))
    );
    project.panels = panelDocs.map(p => p._id);

    // Single save — no gap between project creation and panel association
    await project.save();

    // Add project to admin's joined projects (parallel with populated fetch)
    const [populatedProject] = await Promise.all([
      Project.findById(project._id)
        .populate('developers', 'name email')
        .populate('admins', 'name email')
        .populate('createdBy', 'name email')
        .populate('panels'),
      User.findByIdAndUpdate(req.userId, { $addToSet: { joinedProjects: project._id } }),
    ]);

    res.status(201).json({
      message: 'Project created successfully',
      project: populatedProject
    });

    // Notify the sidebar in real-time — placed AFTER res.json() so the
    // HTTP response is flushed first and the socket call never delays it.
    // Bug fix: createProject was the only mutation that never called this;
    // all other mutations (update/delete/add-admin/remove-member) already do.
    emitProjectUpdated(populatedProject);
  } catch (error) {
    console.error('Create project error:', error);
    res.status(500).json({ message: 'Error creating project', error: error.message });
  }
};

// Get project by ID
export const getProjectById = async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch project and aggregate task stats in parallel — no full task documents needed
    const [project, statsResult] = await Promise.all([
      Project.findById(id)
        .populate('developers', 'name email role')
        .populate('admins', 'name email')
        .populate('createdBy', 'name email')
        .populate('panels'),
      Task.aggregate([
        { $match: { projectId: new mongoose.Types.ObjectId(id) } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: ['$approvedByAdmin', 1, 0] } },
            pending: { $sum: { $cond: [{ $not: ['$completedByDeveloper'] }, 1, 0] } },
            inReview: {
              $sum: {
                $cond: [
                  { $and: ['$completedByDeveloper', { $not: ['$approvedByAdmin'] }] },
                  1, 0
                ]
              }
            },
          }
        }
      ])
    ]);

    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const s = statsResult[0] || { total: 0, completed: 0, pending: 0, inReview: 0 };
    const taskStats = { total: s.total, completed: s.completed, pending: s.pending, inReview: s.inReview };

    res.json({ project, taskStats });
  } catch (error) {
    console.error('Get project by ID error:', error);
    res.status(500).json({ message: 'Error fetching project', error: error.message });
  }
};

// Update project
export const updateProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, status, githubRepository } = req.body;

    const project = await Project.findById(id);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (project.createdBy.toString() !== req.userId.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to update this project' });
    }

    if (name) {
      const duplicate = await Project.findOne({
        _id: { $ne: id },
        createdBy: project.createdBy,
        name: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (duplicate) {
        return res.status(409).json({ message: `Project "${duplicate.name}" already exists.` });
      }
    }

    if (name) project.name = name;
    if (description !== undefined) project.description = description;
    if (githubRepository !== undefined) project.githubRepository = githubRepository;
    if (status) project.status = status;

    await project.save();
    emitProjectUpdated(project);

    const updatedProject = await Project.findById(id)
      .populate('developers', 'name email')
      .populate('admins', 'name email')
      .populate('createdBy', 'name email')
      .populate('panels');

    res.json({ message: 'Project updated successfully', project: updatedProject });
  } catch (error) {
    console.error('Update project error:', error);
    res.status(500).json({ message: 'Error updating project', error: error.message });
  }
};

// Invite developer to project
export const inviteDeveloper = async (req, res) => {
  try {
    const { id } = req.params;
    const { developerId, userId, email, message } = req.body;
    let targetDeveloperId = developerId || userId;

    const project = await Project.findById(id);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can invite developers' });
    }

    // Support invite-by-email: frontend sends email, backend resolves the developer
    let developer;
    if (email && !targetDeveloperId) {
      developer = await User.findOne({ email, role: 'developer' });
      if (!developer) {
        return res.status(404).json({ message: `No developer account found for ${email}` });
      }
      targetDeveloperId = developer._id;
    } else {
      if (!targetDeveloperId) {
        return res.status(400).json({ message: 'Developer id or email is required' });
      }
      developer = await User.findById(targetDeveloperId);
      if (!developer || developer.role !== 'developer') {
        return res.status(404).json({ message: 'Developer not found' });
      }
    }

    const projectDevelopers = Array.isArray(project.developers) ? project.developers : [];
    const isAlreadyMember = projectDevelopers.some(
      (memberId) => memberId.toString() === targetDeveloperId.toString()
    );
    if (isAlreadyMember) {
      return res.status(409).json({ message: 'Developer is already in this project' });
    }

    const existingRequest = await ProjectRequest.findOne({ projectId: id, developerId: targetDeveloperId });
    if (existingRequest?.status === 'pending') {
      return res.status(409).json({ message: 'Invitation already exists for this developer' });
    }
    if (existingRequest) {
      await ProjectRequest.deleteOne({ _id: existingRequest._id });
    }

    const request = await ProjectRequest.create({
      projectId: id,
      developerId: targetDeveloperId,
      senderId: req.userId,
      status: 'pending',
      message: message || `You have been invited to join ${project.name}`
    });

    emitToUser(developer._id.toString(), 'request:new', {
      request: {
        _id: request._id.toString(),
        projectId: id,
        developerId: targetDeveloperId,
        senderId: req.userId.toString(),
        status: request.status,
        message: request.message
      }
    });

    res.status(201).json({
      message: 'Invitation sent successfully',
      request: {
        id: request._id.toString(),
        projectId: id,
        developerId: targetDeveloperId,
        status: request.status,
        message: request.message
      }
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'Invitation already exists for this developer' });
    }
    console.error('Invite developer error:', error);
    res.status(500).json({ message: 'Error inviting developer', error: error.message });
  }
};

// Add admin to project (admin only)
export const addAdminToProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId } = req.body;

    if (!adminId) return res.status(400).json({ message: 'adminId is required' });

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const isCreator = project.createdBy.toString() === req.userId.toString();
    const isCoAdmin = (project.admins || []).some(a => a.toString() === req.userId.toString());
    if (!isCreator && !isCoAdmin) {
      return res.status(403).json({ message: 'Not authorized to add admins to this project' });
    }

    const targetAdmin = await User.findById(adminId);
    if (!targetAdmin || targetAdmin.role !== 'admin') {
      return res.status(404).json({ message: 'Admin user not found' });
    }

    if (adminId.toString() === project.createdBy.toString()) {
      return res.status(400).json({ message: 'This user is already the project owner' });
    }

    const alreadyAdmin = (project.admins || []).some(a => a.toString() === adminId.toString());
    if (alreadyAdmin) {
      return res.status(409).json({ message: 'This admin is already added to the project' });
    }

    project.admins = [...(project.admins || []), adminId];
    await project.save();
    emitProjectUpdated(project);

    await User.findByIdAndUpdate(adminId, { $addToSet: { joinedProjects: project._id } });

    res.json({ message: `${targetAdmin.name} added as project admin`, adminId });
  } catch (error) {
    console.error('Add admin to project error:', error);
    res.status(500).json({ message: 'Error adding admin to project', error: error.message });
  }
};

// Leave project (developer)
export const leaveProject = async (req, res) => {
  try {
    const { id } = req.params;

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!project.developers.includes(req.userId)) {
      return res.status(400).json({ message: 'You are not a member of this project' });
    }

    project.developers = project.developers.filter(
      dev => dev.toString() !== req.userId.toString()
    );
    await project.save();

    await Promise.all([
      User.findByIdAndUpdate(req.userId, { $pull: { joinedProjects: id } }),
      Task.updateMany(
        { projectId: id, assignedDeveloper: req.userId },
        { $unset: { assignedDeveloper: '' }, status: 'pending' }
      ),
    ]);

    emitProjectUpdated(project);
    res.json({ message: 'Successfully left the project' });
  } catch (error) {
    console.error('Leave project error:', error);
    res.status(500).json({ message: 'Error leaving project', error: error.message });
  }
};

// Remove project member (admin only)
export const removeProjectMember = async (req, res) => {
  try {
    const { id, memberId } = req.params;

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (project.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to remove project members' });
    }

    if (memberId.toString() === project.createdBy.toString()) {
      return res.status(400).json({ message: 'Project owner cannot be removed' });
    }

    const member = await User.findById(memberId);
    if (!member || member.role !== 'developer') {
      return res.status(404).json({ message: 'Member not found' });
    }

    const projectDevelopers = Array.isArray(project.developers) ? project.developers : [];
    const isMember = projectDevelopers.some(dev => dev.toString() === memberId.toString());
    if (!isMember) {
      return res.status(400).json({ message: 'User is not a member of this project' });
    }

    project.developers = projectDevelopers.filter(dev => dev.toString() !== memberId.toString());
    await project.save();

    await Promise.all([
      ProjectRequest.deleteMany({ projectId: id, developerId: memberId }),
      User.findByIdAndUpdate(memberId, { $pull: { joinedProjects: id } }),
      Task.updateMany(
        { projectId: id, assignedDeveloper: memberId },
        { $unset: { assignedDeveloper: '' }, status: 'pending' }
      ),
    ]);

    emitProjectUpdated(project);
    res.json({ message: 'Project member removed successfully' });
  } catch (error) {
    console.error('Remove project member error:', error);
    res.status(500).json({ message: 'Error removing project member', error: error.message });
  }
};

// Delete project (admin only)
export const deleteProject = async (req, res) => {
  try {
    const { id } = req.params;

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (project.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this project' });
    }

    // Notify members before deletion so socket event still resolves
    emitProjectUpdated(project);

    await Promise.all([
      Panel.deleteMany({ projectId: id }),
      Task.deleteMany({ projectId: id }),
      ProjectRequest.deleteMany({ projectId: id }),
      User.updateMany({ joinedProjects: id }, { $pull: { joinedProjects: id } }),
    ]);

    await Project.findByIdAndDelete(id);

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Delete project error:', error);
    res.status(500).json({ message: 'Error deleting project', error: error.message });
  }
};

// Get project statistics (aggregation pipeline — no full document loading)
export const getProjectStats = async (req, res) => {
  try {
    const { id } = req.params;

    const [project, statsResult] = await Promise.all([
      Project.findById(id, 'developers progress'),
      Task.aggregate([
        { $match: { projectId: new mongoose.Types.ObjectId(id) } },
        {
          $group: {
            _id: null,
            totalTasks: { $sum: 1 },
            completedTasks: { $sum: { $cond: ['$approvedByAdmin', 1, 0] } },
            pendingTasks: { $sum: { $cond: [{ $not: ['$completedByDeveloper'] }, 1, 0] } },
            inReviewTasks: {
              $sum: {
                $cond: [{ $and: ['$completedByDeveloper', { $not: ['$approvedByAdmin'] }] }, 1, 0]
              }
            },
            urgent: { $sum: { $cond: [{ $eq: ['$priority', 'urgent'] }, 1, 0] } },
            high:   { $sum: { $cond: [{ $eq: ['$priority', 'high'] }, 1, 0] } },
            medium: { $sum: { $cond: [{ $eq: ['$priority', 'medium'] }, 1, 0] } },
            low:    { $sum: { $cond: [{ $eq: ['$priority', 'low'] }, 1, 0] } },
            statusPending:    { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
            statusInProgress: { $sum: { $cond: [{ $eq: ['$status', 'in-progress'] }, 1, 0] } },
            statusReview:     { $sum: { $cond: [{ $eq: ['$status', 'review'] }, 1, 0] } },
            statusCompleted:  { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          }
        }
      ])
    ]);

    if (!project) return res.status(404).json({ message: 'Project not found' });

    const s = statsResult[0] || {};
    const stats = {
      totalTasks:      s.totalTasks      ?? 0,
      completedTasks:  s.completedTasks  ?? 0,
      pendingTasks:    s.pendingTasks    ?? 0,
      inReviewTasks:   s.inReviewTasks   ?? 0,
      totalDevelopers: project.developers.length,
      progress:        project.progress,
      tasksByPriority: {
        urgent: s.urgent ?? 0,
        high:   s.high   ?? 0,
        medium: s.medium ?? 0,
        low:    s.low    ?? 0,
      },
      tasksByStatus: {
        pending:    s.statusPending    ?? 0,
        inProgress: s.statusInProgress ?? 0,
        review:     s.statusReview     ?? 0,
        completed:  s.statusCompleted  ?? 0,
      },
    };

    res.json({ stats });
  } catch (error) {
    console.error('Get project stats error:', error);
    res.status(500).json({ message: 'Error fetching project stats', error: error.message });
  }
};

// Toggle star on a project
export const toggleStar = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const alreadyStarred = (project.starredBy || []).some(
      uid => uid.toString() === userId.toString()
    );

    if (alreadyStarred) {
      await Project.findByIdAndUpdate(id, { $pull: { starredBy: userId } });
    } else {
      await Project.findByIdAndUpdate(id, { $addToSet: { starredBy: userId } });
    }

    return res.json({
      starred: !alreadyStarred,
      message: alreadyStarred ? 'Project un-starred' : 'Project starred',
    });
  } catch (error) {
    console.error('Toggle star error:', error);
    res.status(500).json({ message: 'Error toggling star', error: error.message });
  }
};
