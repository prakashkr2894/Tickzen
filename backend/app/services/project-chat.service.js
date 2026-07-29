import jwt from 'jsonwebtoken';
import Project from '../models/Project.js';
import User from '../models/User.js';
import ProjectChatMessage from '../models/ProjectChatMessage.js';
import Notification from '../models/Notification.js';
import { emitToRoom, emitToUser } from './realtime.service.js';

const typingState = new Map();
const chatRoomSubscribers = new Map();

const getRoomBucket = (roomKey) => {
  const bucket = chatRoomSubscribers.get(roomKey) || { http: new Set(), sockets: new Set() };
  chatRoomSubscribers.set(roomKey, bucket);
  return bucket;
};

const buildNotificationPayload = (notification, sender) => ({
  _id: notification._id,
  userId: notification.userId,
  senderId: sender
    ? {
        _id: sender._id || sender.id,
        name: sender.name,
        email: sender.email,
        role: sender.role
      }
    : notification.senderId,
  projectId: notification.projectId,
  type: notification.type,
  title: notification.title,
  message: notification.message,
  read: notification.read,
  createdAt: notification.createdAt,
  updatedAt: notification.updatedAt
});

export const populateProjectMembers = (query) =>
  query
    .populate('developers', 'name email role')
    .populate('createdBy', 'name email role');

export const hasProjectAccess = (project, user) => {
  if (!project || !user) return false;
  const userId = (user._id || user.id)?.toString?.();
  if (!userId) return false;

  // System admin role has access
  if (user.role === 'admin') return true;

  // Creator / owner has access
  const projectOwnerId = project.createdBy?._id?.toString?.() || project.createdBy?.toString?.();
  if (projectOwnerId && projectOwnerId === userId) return true;

  // Co-admins have access
  if (Array.isArray(project.admins)) {
    const isCoAdmin = project.admins.some(
      (admin) => (admin?._id?.toString?.() || admin?.toString?.()) === userId
    );
    if (isCoAdmin) return true;
  }

  // Assigned developers have access
  if (Array.isArray(project.developers)) {
    const isDev = project.developers.some(
      (dev) => (dev?._id?.toString?.() || dev?.toString?.()) === userId
    );
    if (isDev) return true;
  }

  return false;
};

export const buildConversationFilter = (projectId, userId, conversationWith) => {
  if (!conversationWith) {
    return {
      projectId,
      recipientId: null
    };
  }

  return {
    projectId,
    $or: [
      { senderId: userId, recipientId: conversationWith },
      { senderId: conversationWith, recipientId: userId }
    ]
  };
};

export const formatMember = (member) => {
  if (!member) return null;
  const id = member._id ? member._id.toString() : (member.id ? member.id.toString() : '');
  if (!id) return null;
  return {
    id,
    name: member.name || 'User',
    email: member.email || '',
    role: member.role || 'user'
  };
};

export const getConversationKey = (projectId, recipientId) => `${projectId}:${recipientId || 'public'}`;

export const getChatRoomKey = ({ projectId, conversationWith, userId }) => {
  if (!conversationWith || conversationWith === 'public') {
    return `${projectId}:public`;
  }

  const participants = [userId.toString(), conversationWith.toString()].sort();
  return `${projectId}:dm:${participants.join(':')}`;
};

export const getVisibleChatRoomKeys = ({ projectId, senderId, recipientId }) => {
  if (!recipientId) {
    return [`${projectId}:public`];
  }

  const participants = [senderId.toString(), recipientId.toString()].sort();
  return [`${projectId}:dm:${participants.join(':')}`];
};

export const parseChatToken = async (token) => {
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    return user || null;
  } catch {
    return null;
  }
};

export const subscribeHttpRoom = (roomKey, res) => {
  const bucket = getRoomBucket(roomKey);
  bucket.http.add(res);
};

export const unsubscribeHttpRoom = (roomKey, res) => {
  const bucket = chatRoomSubscribers.get(roomKey);
  if (!bucket) return;
  bucket.http.delete(res);
  if (bucket.http.size === 0 && bucket.sockets.size === 0) {
    chatRoomSubscribers.delete(roomKey);
  }
};

export const subscribeSocketRoom = (roomKey, socket) => {
  const bucket = getRoomBucket(roomKey);
  bucket.sockets.add(socket);
};

export const unsubscribeSocketRoom = (roomKey, socket) => {
  const bucket = chatRoomSubscribers.get(roomKey);
  if (!bucket) return;
  bucket.sockets.delete(socket);
  if (bucket.http.size === 0 && bucket.sockets.size === 0) {
    chatRoomSubscribers.delete(roomKey);
  }
};

export const broadcastChatEvent = (roomKey, eventName, payload) => {
  const bucket = chatRoomSubscribers.get(roomKey);
  if (bucket) {
    const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of bucket.http) {
      try {
        res.write(data);
      } catch {
        unsubscribeHttpRoom(roomKey, res);
      }
    }
  }

  emitToRoom(roomKey, eventName, payload);
};

const pruneTypingState = () => {
  const now = Date.now();
  for (const [key, value] of typingState.entries()) {
    const active = Array.from(value.entries()).filter(([, expiresAt]) => expiresAt > now);
    if (active.length === 0) {
      typingState.delete(key);
      continue;
    }
    typingState.set(key, new Map(active));
  }
};

export const setTypingState = ({ projectId, senderId, senderName, recipientId }) => {
  pruneTypingState();
  const key = getConversationKey(projectId, recipientId);
  const conversation = typingState.get(key) || new Map();
  conversation.set(senderId.toString(), {
    senderId: senderId.toString(),
    senderName,
    expiresAt: Date.now() + 4000
  });
  typingState.set(key, conversation);
};

export const getTypingParticipants = ({ projectId, recipientId, viewerId }) => {
  pruneTypingState();
  const key = getConversationKey(projectId, recipientId);
  const conversation = typingState.get(key) || new Map();
  return Array.from(conversation.values()).filter((participant) => participant.senderId !== viewerId);
};

export const createAndBroadcastProjectChatMessage = async ({
  projectId,
  content,
  recipientId = null,
  user,
  mentionedUserIds = []
}) => {
  if (!content || !content.trim()) {
    throw new Error('Message content is required');
  }

  const project = await populateProjectMembers(Project.findById(projectId));
  if (!project) {
    const error = new Error('Project not found');
    error.statusCode = 404;
    throw error;
  }

  if (!hasProjectAccess(project, user)) {
    const error = new Error('Not authorized to chat in this project');
    error.statusCode = 403;
    throw error;
  }

  let recipient = null;
  if (recipientId) {
    recipient = await User.findById(recipientId).select('name email role');
    if (!recipient) {
      const error = new Error('Recipient not found');
      error.statusCode = 404;
      throw error;
    }
  }

  const message = new ProjectChatMessage({
    projectId,
    senderId: user._id || user.id,
    recipientId: recipient?._id || null,
    content: content.trim()
  });

  await message.save();

  if (recipient) {
    const notification = await Notification.create({
      userId: recipient._id,
      senderId: user._id || user.id,
      projectId,
      type: 'project_chat_dm',
      title: 'New private message',
      message: `${user.name || 'A teammate'} sent you a private message in ${project.name}.`,
      read: false
    });

    emitToUser(recipient._id.toString(), 'notification:new', {
      notification: buildNotificationPayload(notification, user)
    });
  }

  const mentionedIds = Array.isArray(mentionedUserIds)
    ? Array.from(new Set(mentionedUserIds.map((id) => id?.toString?.()).filter(Boolean)))
    : [];

  if (mentionedIds.length > 0) {
    const mentionedUsers = await User.find({ _id: { $in: mentionedIds } }).select('name email role');
    for (const mentionedUser of mentionedUsers) {
      if (recipient && mentionedUser._id.toString() === recipient._id.toString()) {
        continue;
      }

      const notification = await Notification.create({
        userId: mentionedUser._id,
        senderId: user._id || user.id,
        projectId,
        type: 'comment_mentioned',
        title: 'You were mentioned in project chat',
        message: `${user.name || 'A teammate'} mentioned you in ${project.name}.`,
        read: false
      });

      emitToUser(mentionedUser._id.toString(), 'notification:new', {
        notification: buildNotificationPayload(notification, user)
      });
    }
  }

  const populatedMessage = await ProjectChatMessage.findById(message._id)
    .populate('senderId', 'name email role')
    .populate('recipientId', 'name email role');

  const messagePayload = {
    _id: populatedMessage._id,
    projectId: populatedMessage.projectId,
    senderId: populatedMessage.senderId,
    recipientId: populatedMessage.recipientId,
    content: populatedMessage.content,
    createdAt: populatedMessage.createdAt,
    updatedAt: populatedMessage.updatedAt
  };

  for (const roomKey of getVisibleChatRoomKeys({
    projectId,
    senderId: user._id || user.id,
    recipientId: recipient?._id || null
  })) {
    broadcastChatEvent(roomKey, 'message', messagePayload);
  }

  return {
    message: populatedMessage,
    payload: messagePayload,
    project,
    recipient
  };
};
