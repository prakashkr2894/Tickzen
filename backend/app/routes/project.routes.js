import express from 'express';
import { body } from 'express-validator';
import {
  getProjects,
  getAllProjects,
  getDashboard,
  createProject,
  getProjectById,
  updateProject,
  inviteDeveloper,
  leaveProject,
  removeProjectMember,
  deleteProject,
  getProjectStats,
  addAdminToProject,
  toggleStar,
} from '../controllers/project.controller.js';
import { authenticate, authorizeAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

// Validation middleware
const validateProject = [
  body('name').trim().notEmpty().withMessage('Project name is required'),
  body('description').optional().trim()
];

// All routes require authentication
router.use(authenticate);

// Get all projects for current user
router.get('/', getProjects);

// Get all projects (admin)
router.get('/all', authorizeAdmin, getAllProjects);

// Dashboard: all projects + panels + tasks in one request (replaces frontend N+1 polling)
router.get('/dashboard', getDashboard);

// Create new project (admin only)
router.post('/', authorizeAdmin, validateProject, createProject);

// Get project by ID
router.get('/:id', getProjectById);

// Get project statistics
router.get('/:id/stats', getProjectStats);

// Update project (admin only)
router.put('/:id', authorizeAdmin, updateProject);

// Invite developer to project (admin only)
router.post('/:id/invite', authorizeAdmin, inviteDeveloper);

// Add admin to project (admin only — grants full project control)
router.post('/:id/add-admin', authorizeAdmin, addAdminToProject);

// Remove project member (admin only)
router.delete('/:id/members/:memberId', authorizeAdmin, removeProjectMember);

// Leave project (developer)
router.post('/:id/leave', leaveProject);

// Star / un-star a project (any authenticated member)
router.patch('/:id/star', toggleStar);

// Delete project (admin only)
router.delete('/:id', authorizeAdmin, deleteProject);

export default router;
