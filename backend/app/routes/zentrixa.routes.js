/**
 * Zentrixa Routes — Backend-First
 * ================================
 * POST /zentrixa/chat              → handleMessage   (main pipeline)
 * POST /zentrixa/confirm           → handleConfirm   (after user says "yes")
 * POST /zentrixa/transcribe        → proxy to Python Faster-Whisper
 * POST /zentrixa/voice/process     → voice confirmation handler
 * GET  /zentrixa/messages          → getZentrixaMessages
 * DELETE /zentrixa/notifications   → clearZentrixaNotifications
 * PUT  /zentrixa/notifications/clear → same
 * POST /zentrixa/                  → Python classify passthrough (health/test)
 */

import express from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  handleMessage,
  handleConfirm,
  getZentrixaMessages,
  clearZentrixaNotifications,
  saveZentrixaMessage,
  executeConfirmedCommand,
} from '../services/zentrixa-chat.service.js';
import { classifyIntent } from '../services/zentrixa.service.js';

const router = express.Router();

// Multer — memory storage (audio goes straight to Python, no disk writes)
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─────────────────────────────────────────────────────────────────
// Public: Python engine passthrough (no auth — used for healthchecks
// and internal testing only).
// ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: 'text is required' });
    return res.json(await classifyIntent(text));
  } catch (error) {
    console.error('[Zentrixa] classify passthrough error:', error);
    return res.status(500).json({ message: 'Failed to classify intent', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// All routes below require authentication
// ─────────────────────────────────────────────────────────────────
router.use(authenticate);

// ── Audio transcription — proxy to Faster-Whisper Python service ──
/**
 * POST /zentrixa/transcribe
 * Body: multipart/form-data  { audio: <webm blob> }
 * Returns: { text: string }
 */
router.post('/transcribe', audioUpload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No audio file received.' });

    const base  = (process.env.ZENTRIXA_AI_URL || 'http://127.0.0.1:8001').replace(/\/(zentrixa|ai\/parse)?\/?$/, '');
    const url   = `${base}/voice/transcribe`;

    // Forward the audio as multipart to the Python FastAPI
    // Node 18+ has global FormData and Blob
    const form = new FormData();
    form.append('audio', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || 'recording.webm');

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000); // whisper can take up to 30s
    try {
      const pyRes = await fetch(url, { method: 'POST', body: form, signal: ctrl.signal });
      if (!pyRes.ok) {
        const rawErr = await pyRes.text().catch(() => 'Transcription failed');
        let cleanMsg = 'Transcription failed';
        try {
          const parsed = JSON.parse(rawErr);
          cleanMsg = parsed.detail || parsed.message || rawErr;
        } catch {
          cleanMsg = rawErr;
        }
        return res.status(pyRes.status).json({ message: cleanMsg });
      }
      const data = await pyRes.json();
      return res.json({ text: data.text || '' });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error('[Zentrixa] transcribe proxy error:', error);
    return res.status(500).json({ message: 'Transcription service unavailable.' });
  }
});

// ── Main chat pipeline ────────────────────────────────────────────
router.post('/chat', handleMessage);

// ── Confirm pipeline (user clicked Yes / No on confirmation card) ──
router.post('/confirm', handleConfirm);

// ── Voice processing ──────────────────────────────────────────────
/**
 * POST /zentrixa/voice/process
 *
 * Two modes:
 *   confirmed=false (default) — classify + return confirmation card or reply
 *   confirmed=true            — execute the command immediately (voice "yes")
 *
 * Body: { text, context, confirmed? }
 * Returns: { reply, message, executed, path }
 */
router.post('/voice/process', async (req, res) => {
  try {
    const { text = '', context = {}, confirmed = false } = req.body || {};
    const clean = text.trim();
    if (!clean) return res.status(400).json({ reply: 'No transcript received.', executed: false });

    const user = req.user;

    if (confirmed) {
      // Voice confirmed — re-classify to get entities, then execute
      const base    = (process.env.ZENTRIXA_AI_URL || 'http://127.0.0.1:8001').replace(/\/(zentrixa|ai\/parse)?\/?$/, '');
      const ctrl    = new AbortController();
      const timer   = setTimeout(() => ctrl.abort(), 5000);
      let pyResult  = null;
      try {
        const resp = await fetch(`${base}/intent/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean }),
          signal: ctrl.signal,
        });
        if (resp.ok) pyResult = await resp.json();
      } catch { /* ignore — fall back to context payload */ }
      finally { clearTimeout(timer); }

      // Build payload from Python entities + incoming context
      const pyEntities = pyResult?.entities || {};
      const payload = {
        command:      context.pendingCommand?.command || pyResult?.intent?.toLowerCase() || 'unknown',
        project_name: pyEntities.project_name || context.project_name || context.projectName || context.name || '',
        name:         pyEntities.project_name || context.name || '',
        title:        pyEntities.title || pyEntities.task_name || context.title || context.taskName || '',
        projectId:    context.projectId || null,
        projectName:  context.projectName || pyEntities.project_name || '',
        taskId:       context.taskId || null,
        taskName:     context.taskName || pyEntities.task_name || pyEntities.title || '',
        description:  context.description || '',
        ...context.pendingCommand,
      };

      const result = await executeConfirmedCommand({ user, text: clean, context, payload });
      void saveZentrixaMessage({ userId: user?._id, role: 'user',      content: clean,        mode: 'command', intent: payload.command });
      void saveZentrixaMessage({ userId: user?._id, role: 'assistant', content: result.reply,  mode: 'command', intent: payload.command });
      return res.json({ reply: result.reply, message: result.reply, executed: result.executed, path: 'local' });
    }

    // Not confirmed — classify and build the correct voice response.
    // We intercept the response from handleMessage so we can remap
    // requiresConfirmation → path: "pending_confirm" (what useVoiceAction expects).
    const capturedChunks = [];
    let capturedStatusCode = 200;

    // Build a mock res that captures what handleMessage would send
    const mockRes = {
      statusCode: 200,
      _body: null,
      status(code) { this.statusCode = code; capturedStatusCode = code; return this; },
      json(payload) { this._body = payload; return this; },
      // Express compatibility
      setHeader() { return this; },
      getHeader() { return undefined; },
      removeHeader() { return this; },
    };

    await handleMessage({ ...req, body: { ...req.body, message: clean, text: clean } }, mockRes);
    const result = mockRes._body || {};

    // Remap for useVoiceAction — it reads path to decide which callback to fire:
    //   "local" + executed=true  → onActionExecuted
    //   "pending_confirm"        → onConfirmNeeded (shows Yes/No card)
    //   "repeat"                 → onRepeat
    //   anything else            → onFallback
    let voicePath = result.path || 'local';
    if (result.requiresConfirmation || result.type === 'CONFIRM') {
      voicePath = 'pending_confirm';
    } else if (!result.executed && result.path !== 'local') {
      voicePath = result.path || 'local';
    }

    return res.status(capturedStatusCode).json({
      // Standard voice fields
      reply:      result.reply || result.message || '',
      message:    result.reply || result.message || '',
      executed:   Boolean(result.executed),
      path:       voicePath,
      intent:     result.intent || null,
      transcript: clean,
      confidence: result.confidence || null,
      // Entities from payload (useVoiceAction reads these for onConfirmNeeded)
      entities:   result.payload
        ? {
            ...result.payload,
            // Ensure all name aliases are present so setPendingConfirmation works
            project_name: result.payload.project_name || result.payload.name || result.payload.projectName || result.payload.title || '',
            task_name:    result.payload.task_name    || result.payload.taskName || result.payload.title || '',
          }
        : undefined,
      // Full payload so the confirmation card can execute later
      payload:    result.payload,
      command:    result.command,
      // Re-expose requiresConfirmation for the frontend card renderer
      requiresConfirmation: result.requiresConfirmation,
      type:       result.type,
    });

  } catch (error) {
    console.error('[Zentrixa] voice/process error:', error);
    return res.status(500).json({ reply: 'I hit a snag processing your voice command.', executed: false });
  }
});

// ── History ───────────────────────────────────────────────────────
router.get('/messages', getZentrixaMessages);

// ── Notifications ─────────────────────────────────────────────────
router.delete('/notifications',       clearZentrixaNotifications);
router.put('/notifications/clear',    clearZentrixaNotifications);

export default router;
