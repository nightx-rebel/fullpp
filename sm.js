'use strict';

const path   = require('path');
const fs     = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino     = require('pino');
const sharp    = require('sharp');   // ← replaces Jimp entirely

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

async function createSession(sessionId, phone, imagePath) {
  const authDir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const entry = {
    status:      'waiting_pairing',
    pairingCode: null,
    error:       null,
    phone,
    imagePath,
    authDir,
    socket:      null,
    cleanedUp:   false,
  };
  sessions.set(sessionId, entry);

  _startBaileysSession(sessionId, entry).catch((err) => {
    console.error(`[session ${sessionId}] Fatal:`, err);
    entry.status = 'error';
    entry.error  = err.message;
  });
}

function getState(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  return {
    status:      entry.status,
    pairingCode: entry.pairingCode,
    error:       entry.error,
  };
}

async function destroySession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  await _cleanup(sessionId, entry);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _startBaileysSession(sessionId, entry) {
  const { version } = await fetchLatestBaileysVersion();
  const { state: authState, saveCreds } = await useMultiFileAuthState(entry.authDir);

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: authState,
    browser: Browsers.macOS('Safari'),
    generateHighQualityLinkPreview: false,
  });

  entry.socket = sock;
  sock.ev.on('creds.update', saveCreds);

  // Request pairing code once — after a brief delay for WS handshake
  if (!authState.creds.registered) {
    _sleep(2000)
      .then(() => sock.requestPairingCode(entry.phone))
      .then((code) => {
        entry.pairingCode = code?.match(/.{1,4}/g)?.join('-') ?? code;
        entry.status      = 'waiting_pairing';
        console.log(`[session ${sessionId}] Pairing code: ${entry.pairingCode}`);
      })
      .catch((err) => {
        console.error(`[session ${sessionId}] Pairing code error:`, err.message);
        entry.status = 'error';
        entry.error  = `Could not get pairing code: ${err.message}`;
      });
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(`[session ${sessionId}] Connected!`);
      entry.status = 'setting_pfp';

      try {
        const jid = sock.user?.id;
        if (!jid) throw new Error('sock.user.id is not available yet');
        await _setProfilePicture(sock, jid, entry.imagePath);
        console.log(`[session ${sessionId}] Profile picture updated ✓`);
        entry.status = 'done';
      } catch (err) {
        console.error(`[session ${sessionId}] PFP error:`, err.message);
        entry.status = 'error';
        entry.error  = `Connected but failed to set profile picture: ${err.message}`;
      }

      await _sleep(1500);
      await _cleanup(sessionId, entry, true);
    }

    if (connection === 'close') {
      const statusCode      = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[session ${sessionId}] Connection closed. Reconnecting: ${shouldReconnect}, code: ${statusCode}`);

      if (shouldReconnect) {
        entry.socket    = null;
        entry.cleanedUp = false;
        setTimeout(() => {
          _startBaileysSession(sessionId, entry).catch((err) => {
            console.error(`[session ${sessionId}] Reconnect error:`, err.message);
            entry.status = 'error';
            entry.error  = `Reconnect failed: ${err.message}`;
          });
        }, 3000);
        return;
      }

      await _cleanup(sessionId, entry, false);
    }
  });
}

/**
 * Resize image to 640×640 JPEG using sharp (works on all Node versions, no native Jimp issues).
 */
async function _setProfilePicture(sock, jid, imagePath) {
  if (!fs.existsSync(imagePath)) {
    throw new Error('Image file not found: ' + imagePath);
  }

  // sharp: resize + center-crop to 640×640, encode as JPEG quality 85
  const buffer = await sharp(imagePath)
    .resize(640, 640, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85 })
    .toBuffer();

  await sock.updateProfilePicture(jid, buffer);
}

async function _cleanup(sessionId, entry, doLogout = true) {
  if (entry.cleanedUp) return;
  entry.cleanedUp = true;

  if (doLogout && entry.socket) {
    try { await entry.socket.logout(); } catch (_) {}
  }

  if (entry.authDir && fs.existsSync(entry.authDir)) {
    try { fs.rmSync(entry.authDir, { recursive: true, force: true }); } catch (_) {}
  }

  if (entry.imagePath && fs.existsSync(entry.imagePath)) {
    try { fs.unlinkSync(entry.imagePath); } catch (_) {}
  }

  entry.socket = null;
  setTimeout(() => sessions.delete(sessionId), 60_000);
  console.log(`[session ${sessionId}] Cleaned up.`);
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { createSession, getState, destroySession };
