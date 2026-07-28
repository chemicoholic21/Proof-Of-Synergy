import { WebSocketServer, WebSocket } from "ws";
import { VoiceEvent } from "@/lib/webrtc-signal";

const PORT = parseInt(process.env.VOICE_WS_PORT ?? "3001", 10);

interface Session {
  id: string;
  ws: WebSocket;
  createdAt: number;
  audioChunks: Buffer[];
  transcript: string;
}

const sessions = new Map<string, Session>();

function broadcast(sessionId: string, event: VoiceEvent): void {
  const session = sessions.get(sessionId);
  if (session?.ws?.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(event));
  }
}

function handleMessage(session: Session, data: string): void {
  let msg: SignalMessage;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }

  switch (msg.type) {
    case "audio-chunk": {
      const chunk = msg.payload as { data: string; encoding: string };
      if (chunk?.data) {
        const buffer = Buffer.from(chunk.data, chunk.encoding === "base64" ? "base64" : "utf-8");
        session.audioChunks.push(buffer);
        broadcast(session.id, { type: "audio-chunk", data: { received: buffer.length }, timestamp: Date.now() });
      }
      break;
    }
    case "end-of-turn": {
      const transcript = session.audioChunks.map((c) => c.toString("utf-8")).join("");
      broadcast(session.id, { type: "transcript", data: { text: transcript, source: "server" }, timestamp: Date.now() });
      session.transcript = transcript;
      session.audioChunks = [];
      break;
    }
    case "session-start": {
      const sessionId = (msg.payload as { sessionId: string })?.sessionId ?? session.id;
      broadcast(session.id, { type: "session-start", data: { sessionId }, timestamp: Date.now() });
      break;
    }
    case "ice-candidate": {
      broadcast(session.id, { type: "ice-candidate", data: msg.payload, timestamp: Date.now() });
      break;
    }
    case "offer":
    case "answer": {
      broadcast(session.id, { type: msg.type as VoiceEvent["type"], data: msg.payload, timestamp: Date.now() });
      break;
    }
    default:
      break;
  }
}

interface SignalMessage {
  type: string;
  payload: unknown;
  sessionId: string;
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws: WebSocket) => {
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session: Session = {
    id: sessionId,
    ws,
    createdAt: Date.now(),
    audioChunks: [],
    transcript: "",
  };
  sessions.set(sessionId, session);

  ws.send(JSON.stringify({ type: "session-start", payload: { sessionId }, sessionId }));

  ws.on("message", (data: Buffer) => {
    handleMessage(session, data.toString());
  });

  ws.on("close", () => {
    sessions.delete(sessionId);
  });

  ws.on("error", () => {
    sessions.delete(sessionId);
  });
});

console.log(`[voice-ws] WebSocket signaling server listening on port ${PORT}`);

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function getActiveSessionCount(): number {
  return sessions.size;
}