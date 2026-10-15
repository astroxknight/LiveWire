# Livewire

A web messaging prototype where a recipient can see a sender's draft update live while the sender types, alongside ordinary sent messages.

## Requirements

- Node.js 20+
- npm

## Run locally

```bash
npm install
cp .env.example .env
# Set JWT_SECRET to a long random value in .env before exposing the app.
npm start
```

Open http://localhost:3000 in two separate browser profiles. Register two accounts (each username is unique), sign in as one in each profile, and open each other's conversation. Type in one window; the other should see the live draft. Press **Send** to persist and deliver a normal message.

The app creates `livewire.sqlite` in the project directory on first run. Back up that file if you need to retain local prototype data.

## Architecture

```text
Browser (HTML/CSS/JS)
  ├── REST /api/* ── Express ── SQLite
  │      ├── register/login (bcrypt password hashes)
  │      ├── sent message history
  │      └── authenticated session cookie (JWT)
  └── WebSocket ─── ws server
         ├── authenticated from the HTTP-only session cookie
         ├── draft updates sent only to the selected conversation peer
         └── sent-message events broadcast to the two participants
```

## Project structure

```text
livewire-messaging/
├── public/
│   ├── index.html     # app shell and auth form
│   ├── styles.css     # responsive dark UI
│   └── app.js         # browser state, REST, WebSocket and rendering
├── server.js          # API, authentication, SQLite and WebSocket events
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Event protocol

Client → server:
- `{ "type": "open", "username": "alex" }` selects a direct conversation for this socket.
- `{ "type": "draft", "username": "alex", "body": "Hello..." }` sends an ephemeral draft update.

Server → client:
- `{ "type": "ready", "user": ... }`
- `{ "type": "draft", "sender": "...", "body": "..." }`
- `{ "type": "message", "message": ... }`

Drafts are not written to the database. Sent messages are stored in SQLite and loaded through the REST API.

## Important prototype limitations

This is a learning/MVP implementation, not a production-ready messenger:
- No end-to-end encryption; TLS must be terminated by HTTPS/WSS in deployment.
- No rate limiting, email verification, account recovery, device/session management, or moderation.
- Session tokens last seven days. Change `JWT_SECRET` and configure HTTPS before deployment.
- Live drafts are ephemeral. If the recipient is offline or viewing another conversation, they won't receive that update.
- For a multi-instance deployment, use a shared pub/sub layer (e.g. Redis) and a persistent production database.
- Add CSRF protection and origin validation before deploying beyond localhost.
- The browser UI uses textContent for user-supplied message text to avoid HTML injection.
