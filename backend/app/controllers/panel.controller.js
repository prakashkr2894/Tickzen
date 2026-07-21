import Panel from '../models/Panel.js';
import Project from '../models/Project.js';
import { emitProjectUpdated } from '../services/realtime.service.js';

// Get panels by project
export const getPanelsByProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const panels = await Panel.find({ projectId }).sort({ order: 1 });
    res.json({ panels });
  } catch (error) {
    console.error('Get panels error:', error);
    res.status(500).json({ message: 'Error fetching panels', error: error.message });
  }
};

// Create panel
export const createPanel = async (req, res) => {
  try {
    const { name, projectId, description, color, width, height } = req.body;

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (project.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to add panels to this project' });
    }

    const panelCount = await Panel.countDocuments({ projectId });

    const panel = new Panel({
      name,
      projectId,
      description: description || '',
      color: color || '#007bff',
      order: panelCount,
      width: Number(width) || 224,
      height: Number(height) || 364
    });

    await panel.save();

    // Add panel to project and emit update in parallel
    project.panels.push(panel._id);
    await project.save();
    emitProjectUpdated(project);

    res.status(201).json({ message: 'Panel created successfully', panel });
  } catch (error) {
    console.error('Create panel error:', error);
    res.status(500).json({ message: 'Error creating panel', error: error.message });
  }
};

// Update panel
export const updatePanel = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, color, order, width, height } = req.body;

    const panel = await Panel.findById(id);
    if (!panel) {
      return res.status(404).json({ message: 'Panel not found' });
    }

    const project = await Project.findById(panel.projectId);
    if (project.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this panel' });
    }

    if (name !== undefined) panel.name = name;
    if (description !== undefined) panel.description = description;
    if (color !== undefined) panel.color = color;
    if (order !== undefined) panel.order = order;
    if (width !== undefined) panel.width = Number(width);
    if (height !== undefined) panel.height = Number(height);

    await panel.save();
    emitProjectUpdated(project);

    res.json({ message: 'Panel updated successfully', panel });
  } catch (error) {
    console.error('Update panel error:', error);
    res.status(500).json({ message: 'Error updating panel', error: error.message });
  }
};

// Delete panel
export const deletePanel = async (req, res) => {
  try {
    const { id } = req.params;

    const panel = await Panel.findById(id);
    if (!panel) {
      return res.status(404).json({ message: 'Panel not found' });
    }

    const project = await Project.findById(panel.projectId);
    if (project.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this panel' });
    }

    project.panels = project.panels.filter(p => p.toString() !== id);
    await project.save();
    await Panel.findByIdAndDelete(id);
    emitProjectUpdated(project);

    res.json({ message: 'Panel deleted successfully' });
  } catch (error) {
    console.error('Delete panel error:', error);
    res.status(500).json({ message: 'Error deleting panel', error: error.message });
  }
};

// Reorder panels
export const reorderPanels = async (req, res) => {
  try {
    const { projectId, panelOrder } = req.body;

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (project.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to reorder panels' });
    }

    await Promise.all(
      panelOrder.map((panelId, index) =>
        Panel.findByIdAndUpdate(panelId, { order: index })
      )
    );

    const panels = await Panel.find({ projectId }).sort({ order: 1 });
    emitProjectUpdated(project);

    res.json({ message: 'Panels reordered successfully', panels });
  } catch (error) {
    console.error('Reorder panels error:', error);
    res.status(500).json({ message: 'Error reordering panels', error: error.message });
  }
};
