const $ = (selector) => document.querySelector(selector);
const authView = $("#auth-view"), chatView = $("#chat-view");
let user = null, selected = null, ws = null, isRegister = false, reconnectTimer = null;
let draftTimer = null, lastDraftSent = "", receivedDraft = null;
let renderedMessages = [];

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      credentials: "same-origin"
    });
  } catch (error) {
    throw new Error("Cannot reach Livewire server. Check the terminal and make sure this page uses the same port as the running server.");
  }
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : {};
  if (!response.ok) {
    if (response.status === 404 && !contentType.includes("application/json")) {
      throw new Error("This page may be connected to an old server version. Restart Livewire and open the URL/port printed in the terminal.");
    }
    throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  }
  if (!contentType.includes("application/json")) {
    throw new Error("The server returned a non-JSON response. Check that you opened the correct Livewire port.");
  }
  return data;
}
function setAuthMode(register) {
  isRegister = register;
  $("#auth-submit").textContent = register ? "Create account" : "Sign in";
  $("#auth-toggle").textContent = register ? "Already have an account? Sign in" : "New here? Create an account";
  $("#auth-form input[name=password]").autocomplete = register ? "new-password" : "current-password";
  $("#auth-error").textContent = "";
}
$("#auth-toggle").addEventListener("click", () => setAuthMode(!isRegister));
$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = $("#auth-submit");
  button.disabled = true;
  $("#auth-error").textContent = "";
  try {
    const endpoint = isRegister ? "/api/register" : "/api/login";
    const data = await api(endpoint, { method: "POST", body: JSON.stringify({
      username: form.get("username"), password: form.get("password")
    }) });
    user = data.user;
    showChat();
  } catch (error) {
    $("#auth-error").textContent = error.message;
  } finally { button.disabled = false; }
});
$("#logout").addEventListener("click", async () => {
  if (ws) ws.close();
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  user = null; selected = null;
  chatView.classList.add("hidden"); authView.classList.remove("hidden");
});
$("#refresh-users").addEventListener("click", loadUsers);

async function boot() {
  try { const data = await api("/api/me"); user = data.user; showChat(); }
  catch { authView.classList.remove("hidden"); chatView.classList.add("hidden"); }
}
function showChat() {
  authView.classList.add("hidden"); chatView.classList.remove("hidden");
  $("#my-name").textContent = user.username;
  $("#my-avatar").textContent = user.username.slice(0, 1).toUpperCase();
  connectSocket();
  loadUsers();
}
function connectSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.addEventListener("open", () => {
    $("#connection-state").textContent = "Connected · live drafts on";
    if (selected) ws.send(JSON.stringify({ type: "open", username: selected.username }));
  });
  ws.addEventListener("message", (event) => {
    let data; try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === "draft" && selected && data.sender === selected.username) {
      if (data.body === "") { receivedDraft = null; clearDraftPreview(); }
      else { receivedDraft = data.body; renderDraftPreview(data.sender, data.body); }
    } else if (data.type === "message" && selected && data.message.conversationKey === conversationKey(user.id, selected.id)) {
      // HTTP response and WebSocket broadcast may both arrive; de-duplicate by id.
      if (!renderedMessages.some(m => m.id === data.message.id)) {
        renderedMessages.push(data.message); renderMessages();
      }
      if (data.message.sender === selected.username) clearDraftPreview();
    }
  });
  ws.addEventListener("close", () => {
    $("#connection-state").textContent = "Reconnecting…";
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 1200);
  });
  ws.addEventListener("error", () => ws.close());
}
async function loadUsers() {
  try {
    const data = await api("/api/users");
    const list = $("#user-list"); list.replaceChildren();
    if (!data.users.length) {
      const empty = document.createElement("p"); empty.className = "no-users";
      empty.textContent = "No other accounts yet. Open another browser or sign up with a second account to test live chat.";
      list.append(empty); return;
    }
    data.users.forEach((item) => {
      const button = document.createElement("button");
      button.className = `user-row ${selected?.id === item.id ? "active" : ""}`;
      const avatar = document.createElement("span"); avatar.className = "avatar"; avatar.textContent = item.username[0].toUpperCase();
      const info = document.createElement("span"); info.className = "user-info";
      const name = document.createElement("strong"); name.textContent = item.username;
      const sub = document.createElement("small"); sub.textContent = "Open conversation";
      info.append(name, sub); button.append(avatar, info);
      button.addEventListener("click", () => openConversation(item));
      list.append(button);
    });
  } catch (error) { console.error(error); }
}
async function openConversation(peer) {
  selected = peer; receivedDraft = null; lastDraftSent = "";
  $("#peer-name").textContent = peer.username;
  $("#peer-avatar").textContent = peer.username[0].toUpperCase();
  $("#message-input").disabled = false;
  $("#message-input").placeholder = `Write to ${peer.username}…`;
  $("#send-button").disabled = false;
  $("#message-input").value = "";
  $("#messages").replaceChildren();
  clearDraftPreview();
  loadUsers();
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "open", username: peer.username }));
  try {
    const data = await api(`/api/messages/${encodeURIComponent(peer.username)}`);
    renderedMessages = data.messages;
    renderMessages();
  } catch (error) { alert(error.message); }
}
function conversationKey(a, b) { return [Number(a), Number(b)].sort((x,y) => x-y).join(":"); }
function renderMessages() {
  const box = $("#messages"); box.replaceChildren();
  if (!renderedMessages.length) {
    const empty = document.createElement("div"); empty.className = "empty-state";
    const symbol = document.createElement("div"); symbol.className = "empty-symbol"; symbol.textContent = "↗";
    const title = document.createElement("h2"); title.textContent = "Start with a thought.";
    const desc = document.createElement("p"); desc.textContent = "Your draft is shared live with this person. It is not saved as a message until you press Send.";
    empty.append(symbol, title, desc); box.append(empty); return;
  }
  renderedMessages.forEach(message => {
    const item = document.createElement("article");
    const mine = message.sender === user.username;
    item.className = `message ${mine ? "mine" : ""}`;
    const meta = document.createElement("div"); meta.className = "message-meta";
    const sender = document.createElement("span"); sender.textContent = mine ? "You" : message.sender;
    const time = document.createElement("span"); time.textContent = formatTime(message.createdAt);
    meta.append(sender, time);
    const bubble = document.createElement("div"); bubble.className = "bubble"; bubble.textContent = message.body;
    item.append(meta, bubble); box.append(item);
  });
  box.scrollTop = box.scrollHeight;
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function renderDraftPreview(sender, body) {
  $("#draft-indicator").classList.remove("hidden");
  $("#draft-label").textContent = `${sender} is writing a live draft`;
  let item = $("#incoming-draft");
  if (!item) {
    item = document.createElement("article"); item.id = "incoming-draft"; item.className = "message draft-message";
    const meta = document.createElement("div"); meta.className = "message-meta";
    const name = document.createElement("span"); name.textContent = sender;
    const label = document.createElement("span"); label.className = "draft-label"; label.textContent = "LIVE DRAFT";
    meta.append(name, label);
    const bubble = document.createElement("div"); bubble.className = "bubble";
    item.append(meta, bubble); $("#messages").append(item);
  }
  item.querySelector(".bubble").textContent = body || "…";
  $("#messages").scrollTop = $("#messages").scrollHeight;
}
function clearDraftPreview() {
  $("#draft-indicator").classList.add("hidden");
  $("#incoming-draft")?.remove();
}
const input = $("#message-input");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  if (!selected || ws?.readyState !== WebSocket.OPEN) return;
  const body = input.value;
  clearTimeout(draftTimer);
  // Debounce network traffic slightly, while keeping typing-to-screen latency low.
  draftTimer = setTimeout(() => {
    if (body === lastDraftSent || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "draft", username: selected.username, body }));
    lastDraftSent = body;
  }, 35);
});
$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected || !input.value.trim()) return;
  const body = input.value.trim();
  const peer = selected;
  $("#send-button").disabled = true;
  try {
    const data = await api(`/api/messages/${encodeURIComponent(peer.username)}`, {
      method: "POST", body: JSON.stringify({ body })
    });
    if (selected?.id === peer.id && !renderedMessages.some(m => m.id === data.message.id)) {
      renderedMessages.push(data.message); renderMessages();
    }
    input.value = ""; input.style.height = "auto"; lastDraftSent = "";
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "draft", username: peer.username, body: "" }));
  } catch (error) { alert(error.message); }
  finally { $("#send-button").disabled = !selected; input.focus(); }
});
boot();
