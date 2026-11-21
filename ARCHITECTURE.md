# Livewire - Architecture Documentation

## Project Summary

**Livewire** is a real-time web messaging prototype (v0.1.0) demonstrating live drafts that appear as a sender types, alongside ordinary sent messages. It's a learning/MVP implementation, not production-ready. The project was built with Node.js + Express for the backend, SQLite for persistence, and the `ws` library for WebSocket-based real-time communication.

## Technology Stack

| Layer | Technology | Details |
|---|---|---|
| **Backend** | Node.js + Express | HTTP server, REST API routes, WebSocket upgrade handling |
| **Database** | SQLite (`better-sqlite3`) | Local file-based database, WAL journal mode, foreign key constraints |
| **Real-time** | WebSocket (`ws` library) | Full-duplex communication over a single TCP connection |
| **Auth** | JWT cookies + bcrypt | JSON Web Tokens stored in HTTP-only cookies, bcrypt password hashing (12 rounds) |
| **Frontend** | Vanilla HTML/CSS/JS | No framework dependencies; DOM manipulation, event handling, JSON parsing |
| **CSS** | Responsive dark theme | CSS variables, Google Fonts (Inter), custom dark color palette |

## Architecture Diagram

```
Browser (HTML/CSS/JS)
  ├── REST /api/* ── Express ── SQLite
  │      ├── GET    /api/me              # Get current user
  │      ├── POST   /api/register        # Register new user (bcrypt hash)
  │      ├── POST   /api/login           # Login (password comparison)
  │      ├── GET    /api/users           # List all users (excluding self)
  │      ├── GET    /api/messages/:user  # Load conversation history
  │      └── POST   /api/messages/:user  # Send new message
  └── WebSocket ─── ws server
         ├── authenticated from the HTTP-only session cookie
         ├── draft updates sent only to the selected conversation peer
         └── sent-message events broadcast to the two participants
```

## Core Features

1. **User Management**
   - Registration with username validation (`^[a-zA-Z0-9_]{3,20}$`)
   - Login with bcrypt password comparison
   - JWT authentication via HTTP-only cookie (`livewire_session`)
   - Session lasts 7 days

2. **Conversation System**
   - User selection from sidebar filters conversations
   - Conversation key = sorted user IDs joined by `:` (e.g., `1:2`)
   - Messages are scoped to a specific conversation key
   - De-duplication on message receipt (by message ID)

3. **Live Drafts** (ephemeral, NOT persisted to DB)
   - As the sender types, `input` events are debounced at ~35ms
   - Draft updates are broadcast via WebSocket to the selected recipient only
   - Drafts appear as a "LIVE DRAFT" banner in the recipient's window
   - Drafts are NOT written to SQLite; they disappear when the sender sends or closes

4. **Sent Messages**
   - POST to `/api/messages/:username` persists to SQLite
   - Broadcast via WebSocket to both participants
   - Loadable via GET `/api/messages/:username`
   - De-duplication on client side (by message ID)

## How It Works

### Authentication Flow

1. User registers or logs in → server signs a JWT and sets it as an HTTP-only cookie (`livewire_session`)
2. Subsequent requests include the cookie, which Express middleware parses and verifies via `jwt.verify()`
3. The `/api/me` endpoint returns the authenticated user, or `401` if no valid token

### Conversation Flow

1. User selects a partner from the user list → `open` message sent via WebSocket
2. WebSocket connection stores `ws.activeConversation = conversationKey(me, peer)`
3. Messages/drafts are only delivered if `recipientSocket.activeConversation === key`
4. On conversation close or new selection, `activeConversation` is reset

### Draft Broadcasting

1. Typing triggers `input` event → debounced every 35ms
2. Client sends `{ type: "draft", username, body }` over WebSocket
3. Server's `broadcastToConversation(key, payload)` iterates `socketsByUser` and sends only to sockets where `activeConversation === key`
4. Recipient's `app.js` receives the draft and renders the live preview

### Sending Messages

1. Form submission → POST to `/api/messages/:username` with `{ body }`
2. Message is inserted into SQLite with the conversation key
3. Server broadcasts `{ type: "message", message }` to both participants' WebSockets
4. Client de-duplicates by checking if the message ID already exists in rendered messages

## Notable Code Sections

### `server.js`

- **Lines 1-38**: SQLite schema setup (users table, messages table, indexes)
- **Lines 42-68**: Helper functions: `signToken()`, `setSession()`, `getUserFromToken()`, `requireAuth()`
- **Lines 75-77**: `conversationKey(a, b)` — sorts two user IDs and joins with `:`; exists identically in `public/app.js:145`
- **Lines 85-102**: `POST /api/register` — validates username/password, bcrypt hashes, inserts user
- **Lines 104-111**: `POST /api/login` — retrieves user, compares password, sets session cookie
- **Lines 120-123**: `GET /api/users` — lists all users except self
- **Lines 125-135**: `GET /api/messages/:username` — loads conversation history with de-duplication
- **Lines 137-150**: `POST /api/messages/:username` — persists message, broadcasts via WebSocket
- **Lines 152-172**: WebSocket socket management: `socketsByUser` map, `addSocket()`, `removeSocket()`, `broadcastToConversation()`
- **Lines 174-186**: WebSocket upgrade handler — extracts user from cookie token, no Origin validation
- **Lines 188-216**: WebSocket `connection` event handler — message/draft processing, `activeConversation` tracking

### `public/app.js`

- **Lines 1-5**: Utility `$` selector, state variables (`user`, `selected`, `ws`, `receivedDraft`, `renderedMessages`)
- **Lines 7-32**: `api()` helper — fetch with credentials, JSON parsing, error handling
- **Lines 33-63**: Auth mode toggling (register/login form switching)
- **Lines 66-69**: `boot()` — checks `/api/me` on page load, shows auth or chat view
- **Lines 70-76**: `showChat()` — reveals chat UI, connects WebSocket, loads user list
- **Lines 77-104**: `connectSocket()` — establishes WebSocket, handles `open`, `message`, `close`, `error` events
  - Draft rendering (lines 87-96): shows received drafts from selected peer
  - Message de-duplication (lines 90-96): checks `renderedMessages.some(m => m.id === data.message.id)`
- **Lines 105-126**: `loadUsers()` — fetches `/api/users`, renders button list
- **Lines 127-144**: `openConversation()` — selects peer, loads message history, sends `open` WebSocket message
- **Lines 146-167**: `renderMessages()` — renders chat message bubbles, auto-scrolls
- **Lines 168-171**: `formatTime()` — formats timestamp to locale time string
- **Lines 172-191**: `renderDraftPreview()` / `clearDraftPreview()` — shows/hides live draft banner
- **Lines 192-205**: `input` event listener — updates textarea height, debounces draft broadcasts at 35ms
- **Lines 207-223**: `keydown` event listener — **Enter sends, Shift+Enter new line** (recently added)
- **Lines 224-233**: `submit` event listener — sends message via API, clears input, resets draft

### `public/index.html`

- Auth form (username/password, toggle between register/login)
- Chat view (sidebar user list, conversation header, message area, draft indicator, message form)
- Live draft banner with "LIVE DRAFT" text
- CSS-styled message bubbles and layout

## Limitations

| Category | Detail |
|---|---|
| **Security** | No WebSocket origin validation; no CSRF protection; JWT_SECRET is dev-only default |
| **Reliability** | No rate limiting on auth endpoints; session tokens last 7 days |
| **Data persistence** | Live drafts are ephemeral — lost if recipient offline or viewing another conversation |
| **Scalability** | Singleton WebSocket server; for multi-instance deployment, need shared pub/sub (e.g., Redis) |
| **Moderation** | No message moderation, email verification, or account recovery |
| **Encryption** | No end-to-end encryption; TLS/WSS required for production deployment |
| **Origin validation** | Missing — any website can initiate WebSocket connections to the server |

## Recent Modifications (2026-11-22)

### Critical Fixes Applied

1. **`better-sqlite3` native module upgrade** (MODIFICATIONS.md #1)
   - Original v11.x was incompatible with Node.js 26.13.0 due to V8 API changes (removed `GetPrototype`, `Context.GetIsolate`, `PropertyCallbackInfo.This`)
   - Upgraded to v13.2.0 with prebuilt binaries compatible with Node.js 26
   - `package.json` automatically updated to `"better-sqlite3": "^13.2.0"`
   - Server now starts successfully

2. **`cookie.parse()` → `cookie.parseCookie()`** (MODIFICATIONS.md #2)
   - The `cookie` npm package v2.x removed the `.parse()` method
   - Updated both calls in `server.js` (lines 71, 175) to use `.parseCookie()`
   - Fixed the "request failed" / TypeError on every HTTP request

### Bugs Identified Through Analysis

3. **WebSocket origin validation missing** (MODIFICATIONS.md #3)
   - Upgrade handler accepts connections from any origin
   - Recommendation: validate `req.headers.origin` against allowed list

4. **Duplicate `conversationKey` function** (MODIFICATIONS.md #4)
   - Identical function in `server.js:75-77` and `public/app.js:145`
   - Risk of mismatch if implementations diverge
   - Recommendation: extract to shared utility

5. **`activeConversation` not initialized on new connections** (MODIFICATIONS.md #5)
   - `ws.activeConversation` is `undefined` until `"open"` message received
   - Drafts/messages may not deliver before conversation is explicitly opened
   - Recommendation: initialize `ws.activeConversation = null` on connection

6. **No rate limiting on authentication endpoints** (MODIFICATIONS.md #6)
   - `/api/register` and `/api/login` vulnerable to brute-force
   - Recommendation: add `express-rate-limit` or Redis-based limiter

## Project Structure

```
livewire-messaging/
├ public/                    # Frontend assets
│   ├── index.html           # App shell (auth + chat UI)
│   ├── styles.css           # Dark-themed responsive CSS
│   └── app.js               # Client: state, REST, WebSocket, rendering
├ server.js                  # Backend: API, auth, SQLite, WebSocket events
├ package.json               # Dependencies (better-sqlite3@13, express, ws, etc.)
├ README.md                  # General public usage documentation
├ ANALYSIS.md                # Repository analysis (kept for historical reference)
├ MODIFICATIONS.md           # Bug fix log (kept for historical reference)
├ .env.example              # Environment variable examples
└── .gitignore
```

## Current Status

The prototype is functional after the following fixes:
- `better-sqlite3` upgraded from v11 to v13 for Node.js 26 compatibility
- `cookie.parse()` renamed to `cookie.parseCookie()` for npm v2.x compatibility
- Enter/Send and Shift+Enter/New line behavior added to `public/app.js`

Remaining items are production-readiness improvements appropriate for a learning MVP:
- Add WebSocket origin validation
- Add rate limiting
- Configure HTTPS/WSS for deployment
- Add CSRF protection
- Implement end-to-end encryption for production use