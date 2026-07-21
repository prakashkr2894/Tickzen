import mongoose from 'mongoose';
import cron from 'node-cron';

const heartbeatSchema = new mongoose.Schema({
  _id: { type: String, default: 'keep-alive' },
  lastPing: { type: Date, default: Date.now }
}, { collection: 'heartbeat', versionKey: false });

const Heartbeat = mongoose.model('Heartbeat', heartbeatSchema);

export async function runHeartbeat() {
  try {
    await Heartbeat.findOneAndUpdate(
      { _id: 'keep-alive' },
      { lastPing: new Date() },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error('[MongoDB Keep-Alive] Failed to update heartbeat:', error);
  }
}

export function startKeepAlive() {
  // Run on start
  runHeartbeat();
  // Run every 24 hours at midnight Asia/Kolkata timezone
  cron.schedule('0 0 * * *', runHeartbeat, {
    scheduled: true,
    timezone: 'Asia/Kolkata'
  });
  console.log('[MongoDB Keep-Alive] Scheduled keepalive job (daily at 00:00 Asia/Kolkata)');
}
