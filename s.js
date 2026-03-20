'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const sessionManager = require('./sm');

const app  = express();
const PORT = process.env.PORT || 3000;

// Ensure upload directory exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer — store image per session
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/start  — upload image + phone → returns sessionId
app.post('/api/start', upload.single('photo'), async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone)     return res.status(400).json({ error: 'Phone number is required' });
    if (!req.file)  return res.status(400).json({ error: 'Photo is required' });

    // Digits only
    const normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.length < 7) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const sessionId = uuidv4();
    await sessionManager.createSession(sessionId, normalizedPhone, req.file.path);

    res.json({ sessionId });
  } catch (err) {
    console.error('[/api/start]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status/:sessionId — poll for pairing code / connection state
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const state = sessionManager.getState(sessionId);
  if (!state) return res.status(404).json({ error: 'Session not found' });
  res.json(state);
});

// DELETE /api/session/:sessionId — manual cleanup
app.delete('/api/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  await sessionManager.destroySession(sessionId);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multer error handler (catches fileFilter rejections + size limit errors)
// FIX: without this, multer errors crash the process instead of returning 400
// ─────────────────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟢  WhatsApp PFP App running → http://localhost:${PORT}\n`);
});
