import dotenv from 'dotenv';
dotenv.config({ override: true });

import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';
import authRoutes from './app/routes/auth.routes.js';
import projectRoutes from './app/routes/project.routes.js';
import projectCollaborationRoutes from './app/routes/project.collaboration.routes.js';
import taskRoutes from './app/routes/task.routes.js';
import panelRoutes from './app/routes/panel.routes.js';
import requestRoutes from './app/routes/request.routes.js';
import notificationRoutes from './app/routes/notification.routes.js';
import zentrixaRoutes from './app/routes/zentrixa.routes.js';
import Project from './app/models/Project.js';
import {
  createAndBroadcastProjectChatMessage,
  getChatRoomKey,
  hasProjectAccess,
  parseChatToken,
  populateProjectMembers,
  setTypingState,
  subscribeSocketRoom,
  unsubscribeSocketRoom
} from './app/services/project-chat.service.js';
import { setRealtimeServer } from './app/services/realtime.service.js';
import { startKeepAlive } from './app/utils/keepalive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Startup guards — fail fast if required secrets are missing ──────────────
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is missing. Set it in your environment.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'tickzen_default_secret_key_2026';
process.env.JWT_SECRET = JWT_SECRET;
// ─────────────────────────────────────────────────────────────────────────────

mongoose.set('bufferCommands', false);

const app = express();
const server = http.createServer(app);

// Allowed origins: local dev + production domain(s) via env
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:4500,https://tickzen.in.net,https://www.tickzen.in.net,http://localhost:8080')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: ALLOWED_ORIGINS,
  credentials: true,
};


const io = new SocketIOServer(server, { cors: corsOptions });
setRealtimeServer(io);

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/projects', projectCollaborationRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/panels', panelRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/zentrixa', zentrixaRoutes);

// Health check
app.get('/api/health', (req, res) => {
  const isMongoReady = mongoose.connection.readyState === 1;
  res.status(isMongoReady ? 200 : 503).json({
    status: isMongoReady ? 'OK' : 'DEGRADED',
    message: isMongoReady ? 'Server is running' : 'MongoDB is not connected',
    database: isMongoReady ? 'connected' : 'disconnected',
  });
});

const sendSocketError = (socket, message) => {
  try { socket.emit('chat:error', { message }); } catch { /* ignore */ }
};

io.on('connection', async (socket) => {
  try {
    const projectId = socket.handshake.query.projectId?.toString() || '';
    const conversationWith = socket.handshake.query.conversationWith?.toString() || 'public';
    const token = socket.handshake.auth?.token?.toString() || socket.handshake.query.token?.toString() || '';

    const user = await parseChatToken(token);
    if (!user) {
      sendSocketError(socket, 'Invalid or missing token');
      socket.disconnect(true);
      return;
    }

    const project = await populateProjectMembers(Project.findById(projectId));
    if (!project) {
      sendSocketError(socket, 'Project not found');
      socket.disconnect(true);
      return;
    }

    if (!hasProjectAccess(project, user)) {
      sendSocketError(socket, 'Not authorized to view this project');
      socket.disconnect(true);
      return;
    }

    const roomKey = getChatRoomKey({ projectId, conversationWith, userId: user._id.toString() });

    subscribeSocketRoom(roomKey, socket);
    socket.join(roomKey);
    socket.join(`user:${user._id.toString()}`);
    socket.emit('chat:ready', { roomKey });

    socket.on('chat:typing', async () => {
      try {
        setTypingState({
          projectId,
          senderId: user._id,
          senderName: user.name,
          recipientId: conversationWith === 'public' ? null : conversationWith
        });
        socket.to(roomKey).emit('chat:typing', {
          senderId: user._id.toString(),
          senderName: user.name
        });
      } catch (error) {
        sendSocketError(socket, error.message || 'Typing update failed');
      }
    });

    socket.on('chat:message', async (payload) => {
      try {
        const result = await createAndBroadcastProjectChatMessage({
          projectId,
          content: payload?.content,
          recipientId: conversationWith === 'public' ? null : conversationWith,
          user,
          mentionedUserIds: Array.isArray(payload?.mentionedUserIds) ? payload.mentionedUserIds : []
        });
        socket.emit('chat:message:ack', { messageId: result.message._id.toString() });
      } catch (error) {
        sendSocketError(socket, error.message || 'Invalid chat payload');
      }
    });

    socket.on('disconnect', () => {
      unsubscribeSocketRoom(roomKey, socket);
    });
  } catch (error) {
    sendSocketError(socket, error.message || 'WebSocket error');
    socket.disconnect(true);
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!', error: err.message });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => {
      console.log('✅ Connected to MongoDB');
      startKeepAlive();
    })
    .catch((error) => {
      console.error('MongoDB connection error:', error.message);
    });
});

export default app;
