let ioInstance = null;

export const setRealtimeServer = (io) => {
  ioInstance = io;
};

export const getRealtimeServer = () => ioInstance;

export const emitToRoom = (room, event, payload) => {
  if (!ioInstance) return;
  ioInstance.to(room).emit(event, payload);
};

export const emitToUser = (userId, event, payload) => {
  if (!ioInstance) return;
  ioInstance.to(`user:${userId}`).emit(event, payload);
};

/**
 * Broadcasts a 'project:updated' event to all members of a project so they
 * know to reload their project data.  Used by task/panel/project controllers
 * after any mutation — this is what replaces the 1-second polling loop.
 *
 * @param {import('mongoose').Document} project - The project document (must have .developers, .admins, .createdBy populated or as ObjectId array)
 */
export const emitProjectUpdated = (project) => {
  if (!ioInstance || !project) return;

  const memberIds = new Set();

  // Project creator
  const creatorId = project.createdBy?._id?.toString() ?? project.createdBy?.toString();
  if (creatorId) memberIds.add(creatorId);

  // Co-admins
  for (const admin of (project.admins || [])) {
    const id = admin?._id?.toString() ?? admin?.toString();
    if (id) memberIds.add(id);
  }

  // Developers
  for (const dev of (project.developers || [])) {
    const id = dev?._id?.toString() ?? dev?.toString();
    if (id) memberIds.add(id);
  }

  const payload = { projectId: project._id?.toString() ?? project.toString() };

  for (const userId of memberIds) {
    ioInstance.to(`user:${userId}`).emit('project:updated', payload);
  }
};
