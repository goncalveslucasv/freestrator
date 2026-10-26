"use client";

// Live link with the Freestrator MCP server (mcp/bridge.ts): what Claude draws appears here, and
// edits made here are sent back so Claude sees them.

import { BRIDGE_PORT, decodeAsset, docMessages, type BridgeMessage } from "./sync";
import { getNodes } from "./ops";
import { loadDoc, replaceDoc, select, useEditor } from "./store";
import type { Doc } from "./types";

const STORAGE_KEY = "freestrator:bridge";
const PORT_KEY = "freestrator:bridge-port";
const RETRY_MS = 2000;
const SEND_DELAY_MS = 300;

let ws: WebSocket | null = null;
let enabled = false;
/** The MCP server may listen on a later port when another session holds the default one. */
let port = BRIDGE_PORT;
let retry: ReturnType<typeof setTimeout> | undefined;
let sendTimer: ReturnType<typeof setTimeout> | undefined;
/** Asset ids the server already has (reset on every connection). */
let sent = new Set<string>();
/** Last document exchanged with the server, so it isn't echoed back. */
let synced: Doc | null = null;
let unsubscribe: (() => void) | null = null;

const setStatus = (bridge: "off" | "connecting" | "on") => useEditor.setState({ bridge });
const send = (msg: BridgeMessage) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

function connect() {
  clearTimeout(retry);
  setStatus("connecting");
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  ws = socket;

  socket.onopen = async () => {
    sent = new Set();
    setStatus("on");
    const { doc } = useEditor.getState();
    synced = doc;
    if (!doc) return send({ type: "hello", doc: null });
    for (const msg of await docMessages(doc, sent)) send(msg.type === "doc" ? { type: "hello", doc: msg.doc } : msg);
  };

  socket.onmessage = (e) => {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "asset") {
      decodeAsset(msg.asset);
      sent.add(msg.asset.id);
    } else if (msg.type === "doc") {
      synced = msg.doc;
      if (useEditor.getState().doc) replaceDoc(msg.doc);
      else loadDoc(msg.doc);
    } else if (msg.type === "selection") {
      const { doc } = useEditor.getState();
      if (doc) select(getNodes(doc, msg.ids).map((n) => n.id));
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    if (enabled) {
      setStatus("connecting");
      retry = setTimeout(connect, RETRY_MS);
    } else setStatus("off");
  };
}

/** Sends local edits once the document settles (not in the middle of a drag). */
function watchStore() {
  unsubscribe?.();
  unsubscribe = useEditor.subscribe((state, prev) => {
    if (state.selection !== prev.selection) send({ type: "selection", ids: state.selection });
    if (state.doc === prev.doc && state.txBase === prev.txBase) return;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(async () => {
      const { doc, txBase } = useEditor.getState();
      if (!doc || txBase || doc === synced || ws?.readyState !== WebSocket.OPEN) return;
      synced = doc;
      for (const msg of await docMessages(doc, sent)) send(msg);
    }, SEND_DELAY_MS);
  });
}

export function setBridgeEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // storage unavailable: the setting just won't persist
  }
  if (on) {
    watchStore();
    if (!ws) connect();
  } else {
    clearTimeout(retry);
    unsubscribe?.();
    unsubscribe = null;
    const socket = ws;
    ws = null;
    socket?.close();
    setStatus("off");
  }
}

/**
 * Connects on load when Claude opened this page (`?claude=<port>`, see openEditor in
 * mcp/bridge.ts), or if the link was on last time.
 */
export function restoreBridge() {
  const url = new URL(location.href);
  const requested = Number(url.searchParams.get("claude"));
  try {
    if (requested > 0) {
      localStorage.setItem(PORT_KEY, String(requested));
      url.searchParams.delete("claude");
      history.replaceState(history.state, "", url);
    }
    port = Number(localStorage.getItem(PORT_KEY)) || BRIDGE_PORT;
    if (requested > 0 || localStorage.getItem(STORAGE_KEY) === "1") setBridgeEnabled(true);
  } catch {
    // storage unavailable: still honour the link Claude opened
    if (requested > 0) {
      port = requested;
      setBridgeEnabled(true);
    }
  }
}
