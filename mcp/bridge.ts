// WebSocket bridge to the browser editor: every change Claude makes shows up live in Freestrator,
// and edits made by hand in the editor come back to the MCP session.

import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { APP_ORIGINS, decodeAsset, docMessages, type BridgeMessage } from "../src/lib/sync";
import type { Doc } from "../src/lib/types";
import { log } from "./log";
import { session } from "./session";

interface Client {
  ws: WebSocket;
  /** Asset ids this editor already has. */
  sent: Set<string>;
  ready: boolean;
  /** Outgoing messages are serialised so a selection never overtakes its document. */
  queue: Promise<void>;
}

const clients = new Set<Client>();

// Any web page can try to reach localhost, so only known origins may connect: the hosted editor,
// pages served from this machine, and whatever FREESTRATOR_ALLOWED_ORIGINS adds (comma-separated).
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const ALLOWED = new Set([
  ...APP_ORIGINS,
  ...(process.env.FREESTRATOR_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
]);
const allowedOrigin = (origin?: string) => !origin || LOCAL_ORIGIN.test(origin) || ALLOWED.has(origin);

function enqueue(c: Client, task: () => Promise<void> | void) {
  c.queue = c.queue.then(task).catch((err) => log("Error enviando al editor:", err));
}

function sendDoc(c: Client, doc: Doc, label?: string) {
  enqueue(c, async () => {
    for (const msg of await docMessages(doc, c.sent, label)) c.ws.send(JSON.stringify(msg));
  });
}

/** Other Claude sessions may already hold the default port, so try a few after it. */
const PORT_ATTEMPTS = 10;
/** Port the bridge ended up listening on (null until it listens, or if it couldn't). */
let listeningPort: number | null = null;
let editorOpened = false;

export function startBridge(port: number, attempt = 0) {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port,
    maxPayload: 2 ** 30,
    verifyClient: ({ origin }: { origin?: string }) => {
      const ok = allowedOrigin(origin);
      if (!ok) log(`Conexión rechazada desde ${origin}`);
      return ok;
    },
  });
  wss.on("listening", () => {
    listeningPort = port;
    log(`Puente con el editor escuchando en ws://127.0.0.1:${port}`);
  });
  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && listeningPort === null && attempt + 1 < PORT_ATTEMPTS) {
      wss.close();
      startBridge(port + 1, attempt + 1);
    } else log(`Puente con el editor desactivado: ${err.message}`);
  });

  wss.on("connection", (ws) => {
    const client: Client = { ws, sent: new Set(), ready: false, queue: Promise.resolve() };
    clients.add(client);
    session.editors = clients.size;
    log("Editor conectado");

    ws.on("message", (data) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      switch (msg.type) {
        case "asset":
          decodeAsset(msg.asset);
          client.sent.add(msg.asset.id);
          break;
        case "hello":
          client.ready = true;
          // The editor's open document wins; an empty editor gets the session's document.
          if (msg.doc) {
            session.setDoc(msg.doc, "editor", "Documento del editor");
            broadcast(msg.doc, client);
          } else {
            sendDoc(client, session.doc);
          }
          break;
        case "doc":
          session.setDoc(msg.doc, "editor", msg.label);
          broadcast(msg.doc, client);
          break;
        case "selection":
          session.selection = msg.ids;
          break;
      }
    });
    ws.on("close", () => {
      clients.delete(client);
      session.editors = clients.size;
      log("Editor desconectado");
    });
  });

  // Retries on another port call startBridge again; subscribe only once.
  if (attempt === 0)
    session.onChange((doc, origin, label) => {
      if (origin === "claude") broadcast(doc, null, label);
    });
}

/**
 * Opens the web editor already linked to this server, once per session and only if no editor is
 * connected. FREESTRATOR_OPEN_EDITOR=0 turns it off; FREESTRATOR_EDITOR_URL points it elsewhere.
 */
export function openEditor() {
  if (editorOpened || clients.size || listeningPort === null || process.env.FREESTRATOR_OPEN_EDITOR === "0") return;
  editorOpened = true;
  const url = new URL(process.env.FREESTRATOR_EDITOR_URL || APP_ORIGINS[0]);
  url.searchParams.set("claude", String(listeningPort));
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url.href]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.href]]
        : ["xdg-open", [url.href]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", (err) => log(`No se pudo abrir el editor (${url.href}): ${err.message}`));
  child.unref();
  log(`Editor abierto: ${url.href}`);
}

function broadcast(doc: Doc, except: Client | null, label?: string) {
  for (const c of clients) if (c !== except && c.ready) sendDoc(c, doc, label);
}

/** Asks connected editors to select these objects. */
export function selectInEditor(ids: string[]) {
  const msg: BridgeMessage = { type: "selection", ids };
  for (const c of clients) if (c.ready) enqueue(c, () => c.ws.send(JSON.stringify(msg)));
}
