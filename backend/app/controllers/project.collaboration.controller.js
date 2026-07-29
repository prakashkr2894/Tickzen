import Project from '../models/Project.js';
import ProjectChatMessage from '../models/ProjectChatMessage.js';
import ProjectMeeting from '../models/ProjectMeeting.js';
import Notification from '../models/Notification.js';
import { emitToUser } from '../services/realtime.service.js';
import {
  buildConversationFilter,
  createAndBroadcastProjectChatMessage,
  formatMember,
  getChatRoomKey,
  getTypingParticipants,
  hasProjectAccess,
  parseChatToken,
  populateProjectMembers,
  setTypingState,
  subscribeHttpRoom,
  unsubscribeHttpRoom
} from '../services/project-chat.service.js';

export const getProjectChatMessages = async (req, res) => {
  try {
    const { projectId } = req.params;
    const conversationWith = req.query.conversationWith?.toString() || '';

    const project = await populateProjectMembers(Project.findById(projectId));
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (!hasProjectAccess(project, req.user)) {
      return res.status(403).json({ message: 'Not authorized to view this project' });
    }

    const filter = buildConversationFilter(projectId, req.userId, conversationWith || null);

    const messages = await ProjectChatMessage.find(filter)
      .populate('senderId', 'name email role')
      .populate('recipientId', 'name email role')
      .sort({ createdAt: 1 });

    res.json({
      messages,
      members: [
        formatMember(project.createdBy),
        ...(Array.isArray(project.developers) ? project.developers.map(formatMember) : [])
      ].filter(Boolean)
    });
  } catch (error) {
    console.error('Get project chat messages error:', error);
    res.status(500).json({ message: 'Error fetching chat messages', error: error.message });
  }
};

export const streamProjectChat = async (req, res) => {
  try {
    const { projectId } = req.params;
    const conversationWith = req.query.conversationWith?.toString() || 'public';
    const token = req.query.token?.toString() || '';
    const user = await parseChatToken(token);

    if (!user) {
      return res.status(401).json({ message: 'Invalid or missing token' });
    }

    const project = await populateProjectMembers(Project.findById(projectId));
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (!hasProjectAccess(project, user)) {
      return res.status(403).json({ message: 'Not authorized to view this project' });
    }

    const roomKey = getChatRoomKey({
      projectId,
      conversationWith,
      userId: user._id.toString()
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.write(`event: ready\ndata: ${JSON.stringify({ roomKey })}\n\n`);
    subscribeHttpRoom(roomKey, res);

    const heartbeat = setInterval(() => {
      try {
        res.write('event: ping\ndata: {}\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeHttpRoom(roomKey, res);
    });
  } catch (error) {
    console.error('Stream project chat error:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Error starting chat stream', error: error.message });
    } else {
      res.end();
    }
  }
};

export const getProjectTypingStatus = async (req, res) => {
  try {
    const { projectId } = req.params;
    const recipientId = req.query.recipientId?.toString() || null;

    const project = await populateProjectMembers(Project.findById(projectId));
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (!hasProjectAccess(project, req.user)) {
      return res.status(403).json({ message: 'Not authorized to view this project' });
    }

    const typingUsers = getTypingParticipants({
      projectId,
      recipientId,
      viewerId: req.userId.toString()
    });

    res.json({ typingUsers });
  } catch (error) {
    console.error('Get project typing status error:', error);
    res.status(500).json({ message: 'Error fetching typing status', error: error.message });
  }
};

export const setProjectTypingStatus = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { recipientId } = req.body;

    const project = await populateProjectMembers(Project.findById(projectId));
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (!hasProjectAccess(project, req.user)) {
      return res.status(403).json({ message: 'Not authorized to chat in this project' });
    }

    setTypingState({
      projectId,
      senderId: req.userId,
      senderName: req.user.name,
      recipientId: recipientId || null
    });

    res.json({ message: 'Typing status updated' });
  } catch (error) {
    console.error('Set project typing status error:', error);
    res.status(500).json({ message: 'Error updating typing status', error: error.message });
  }
};

export const sendProjectChatMessage = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { content, recipientId, mentionedUserIds } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'Message content is required' });
    }

    const result = await createAndBroadcastProjectChatMessage({
      projectId,
      content,
      recipientId: recipientId || null,
      user: req.user,
      mentionedUserIds: Array.isArray(mentionedUserIds) ? mentionedUserIds : []
    });

    res.status(201).json({
      message: 'Chat message sent successfully',
      chatMessage: result.message
    });
  } catch (error) {
    console.error('Send project chat message error:', error);
    res.status(error.statusCode || 500).json({ message: 'Error sending chat message', error: error.message });
  }
};

export const getProjectMeetings = async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await populateProjectMembers(Project.findById(projectId));
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (!hasProjectAccess(project, req.user)) {
      return res.status(403).json({ message: 'Not authorized to view this project' });
    }

    const meetings = await ProjectMeeting.find({ projectId })
      .populate('createdBy', 'name email role')
      .sort({ scheduledFor: 1, createdAt: -1 });

    res.json({ meetings });
  } catch (error) {
    console.error('Get project meetings error:', error);
    res.status(500).json({ message: 'Error fetching meetings', error: error.message });
  }
};

export const createProjectMeeting = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { title, scheduledFor, notes, meetingLink } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Meeting title is required' });
    }

    if (!scheduledFor) {
      return res.status(400).json({ message: 'Meeting date and time is required' });
    }

    const project = await populateProjectMembers(Project.findById(projectId));
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    if (!hasProjectAccess(project, req.user)) {
      return res.status(403).json({ message: 'Not authorized to schedule meetings for this project' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can schedule meetings' });
    }

    const meeting = new ProjectMeeting({
      projectId,
      createdBy: req.userId,
      title: title.trim(),
      scheduledFor: new Date(scheduledFor),
      notes: notes || '',
      meetingLink: meetingLink?.trim() || ''
    });

    await meeting.save();

    const populatedMeeting = await ProjectMeeting.findById(meeting._id)
      .populate('createdBy', 'name email role');

    const recipientIds = Array.from(new Set([
      project.createdBy?._id?.toString?.() || project.createdBy?.toString?.(),
      ...(project.developers || []).map((member) => member?._id?.toString?.() || member?.toString?.()),
    ].filter(Boolean))).filter((id) => id !== req.userId.toString());

    if (recipientIds.length > 0) {
      const notifications = await Notification.insertMany(
        recipientIds.map((recipientId) => ({
          userId: recipientId,
          senderId: req.userId,
          projectId,
          type: 'meeting_reminder',
          title: 'Meeting reminder',
          message: `${title.trim()} is scheduled for ${new Date(scheduledFor).toLocaleString()}.`,
          read: false
        }))
      );

      for (const notification of notifications) {
        emitToUser(notification.userId.toString(), 'notification:new', {
          notification: {
            _id: notification._id,
            userId: notification.userId,
            senderId: notification.senderId,
            projectId: notification.projectId,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            read: notification.read,
            createdAt: notification.createdAt,
            updatedAt: notification.updatedAt
          }
        });
      }
    }

    res.status(201).json({
      message: 'Meeting scheduled successfully',
      meeting: populatedMeeting
    });
  } catch (error) {
    console.error('Create project meeting error:', error);
    res.status(500).json({ message: 'Error scheduling meeting', error: error.message });
  }
};
