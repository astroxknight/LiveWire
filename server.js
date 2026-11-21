require("dotenv").config();
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const Database = require("better-sqlite3");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-this-secret-before-deploying";
const COOKIE_NAME = "livewire_session";
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const db = new Database(path.join(__dirname, "livewire.sqlite"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_key TEXT NOT NULL,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_key, id);
`);

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

function signToken(user) {
  return jwt.sign({ sub: String(user.id), username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}
function setSession(res, user) {
  res.cookie(COOKIE_NAME, signToken(user), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}
function getUserFromToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: Number(payload.sub), username: payload.username };
  } catch {
    return null;
  }
}
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const user = token && getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Please sign in." });
  req.user = user;
  next();
}
// Parse cookies without adding another middleware dependency.
app.use((req, _res, next) => {
  req.cookies = cookie.parseCookie(req.headers.cookie || "");
  next();
});

function conversationKey(a, b) {
  return [Number(a), Number(b)].sort((x, y) => x - y).join(":");
}
function validUsername(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(value);
}
function publicUser(row) {
  return { id: row.id, username: row.username };
}

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: "Username must be 3–20 letters, numbers, or underscores." });
  if (typeof password !== "string" || password.length < 4 || password.length > 200) {
    return res.status(400).json({ error: "Password must be between 4 and 200 characters." });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
    const user = { id: Number(result.lastInsertRowid), username };
    setSession(res, user);
    res.status(201).json({ user });
  } catch (err) {
    if (String(err.code).includes("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "That username is already taken." });
    console.error(err);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") return res.status(400).json({ error: "Enter your username and password." });
  const row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!row || !(await bcrypt.compare(password, row.password_hash))) return res.status(401).json({ error: "Incorrect username or password." });
  setSession(res, publicUser(row));
  res.json({ user: publicUser(row) });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: req.user }));

app.get("/api/users", requireAuth, (req, res) => {
  const users = db.prepare("SELECT id, username FROM users WHERE id != ? ORDER BY username COLLATE NOCASE").all(req.user.id);
  res.json({ users });
});

app.get("/api/messages/:username", requireAuth, (req, res) => {
  const peer = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
  if (!peer) return res.status(404).json({ error: "User not found." });
  const key = conversationKey(req.user.id, peer.id);
  const messages = db.prepare(`
    SELECT m.id, m.body, m.created_at AS createdAt, u.username AS sender
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_key = ? ORDER BY m.id DESC LIMIT 100
  `).all(key).reverse();
  res.json({ peer: publicUser(peer), messages });
});

app.post("/api/messages/:username", requireAuth, (req, res) => {
  const peer = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
  if (!peer) return res.status(404).json({ error: "User not found." });
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > 4000) return res.status(400).json({ error: "Message must be between 1 and 4,000 characters." });
  const key = conversationKey(req.user.id, peer.id);
  const result = db.prepare("INSERT INTO messages (conversation_key, sender_id, body) VALUES (?, ?, ?)").run(key, req.user.id, body);
  const message = {
    id: Number(result.lastInsertRowid), body, sender: req.user.username,
    createdAt: new Date().toISOString(), conversationKey: key
  };
  broadcastToConversation(key, { type: "message", message });
  res.status(201).json({ message });
});

const socketsByUser = new Map();
function addSocket(userId, ws) {
  const set = socketsByUser.get(userId) || new Set();
  set.add(ws);
  socketsByUser.set(userId, set);
}
function removeSocket(userId, ws) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) socketsByUser.delete(userId);
}
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function broadcastToConversation(key, payload) {
  const ids = key.split(":").map(Number);
  for (const id of ids) for (const ws of socketsByUser.get(id) || []) {
    if (ws.activeConversation === key) send(ws, payload);
  }
}

server.on("upgrade", (req, socket, head) => {
  const cookies = cookie.parseCookie(req.headers.cookie || "");
  const user = getUserFromToken(cookies[COOKIE_NAME]);
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  addSocket(ws.user.id, ws);
  send(ws, { type: "ready", user: ws.user });
  ws.on("message", (raw) => {
    if (raw.length > 8000) return send(ws, { type: "error", error: "Update too large." });
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type === "open" && typeof data.username === "string") {
      const peer = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(data.username);
      if (!peer) return;
      ws.activeConversation = conversationKey(ws.user.id, peer.id);
      return send(ws, { type: "opened", username: data.username });
    }
    if (data.type === "draft" && typeof data.username === "string" && typeof data.body === "string") {
      const peer = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(data.username);
      if (!peer || peer.id === ws.user.id || data.body.length > 4000) return;
      const key = conversationKey(ws.user.id, peer.id);
      const payload = {
        type: "draft", conversationKey: key, sender: ws.user.username,
        body: data.body, updatedAt: Date.now()
      };
      // Only the other participant receives the draft. Never persist drafts.
      for (const recipientSocket of socketsByUser.get(peer.id) || []) {
        if (recipientSocket.activeConversation === key) send(recipientSocket, payload);
      }
    }
  });
  ws.on("close", () => removeSocket(ws.user.id, ws));
});

server.listen(PORT, () => console.log(`Livewire running at http://localhost:${PORT}`));
