/**
 * WebRTC signaling client for the voice agent.
 *
 * Manages the WebSocket connection to the server's signaling endpoint,
 * handles ICE candidate exchange, and provides a simple API for creating
 * and answering peer connections.
 *
 * The browser side uses the native WebRTC APIs; this module abstracts the
 * signaling plumbing so the rest of the application can focus on audio
 * streaming.
 */

export interface SignalMessage {
  type: string;
  payload: unknown;
  sessionId: string;
}

export interface IceCandidate {
  candidate: string;
  sdpMLineIndex: number;
  sdpMid: string;
}

export interface OfferPayload {
  sdp: string;
  type: "offer";
}

export interface AnswerPayload {
  sdp: string;
  type: "answer";
}

export type VoiceEventType = "audio-chunk" | "transcript" | "session-start" | "session-end" | "ice-candidate" | "offer" | "answer" | "error";

export interface VoiceEvent {
  type: VoiceEventType;
  data: unknown;
  timestamp: number;
}

export interface WebrtcSignalOptions {
  url: string;
  sessionId: string;
  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (event: VoiceEvent) => void;
  onError?: (error: Error) => void;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
}

export class WebrtcSignalClient {
  private ws: WebSocket | null = null;
  private options: WebrtcSignalOptions;
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandlers: Map<string, Set<(payload: unknown) => void>> = new Map();
  private closed: boolean = false;

  constructor(options: WebrtcSignalOptions) {
    this.options = options;
  }

  /** Connect to the signaling server. */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const url = this.options.url;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.send({ type: "register", sessionId: this.options.sessionId });
      if (this.options.onOpen) this.options.onOpen();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: SignalMessage = JSON.parse(event.data);
        this.dispatch(msg.type, msg.payload);
        if (this.options.onMessage) {
          this.options.onMessage({
            type: msg.type as VoiceEvent["type"],
            data: msg.payload,
            timestamp: Date.now(),
          });
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      if (this.closed) return;
      if (this.options.onClose) this.options.onClose();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      if (this.options.onError) {
        this.options.onError(new Error("WebSocket connection error"));
      }
    };
  }

  /** Send a message to the signaling server. */
  send(message: { type: string; payload?: unknown; sessionId?: string }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const envelope: SignalMessage = {
        type: message.type,
        payload: message.payload ?? null,
        sessionId: message.sessionId ?? this.options.sessionId,
      };
      this.ws.send(JSON.stringify(envelope));
    }
  }

  /** Register a handler for a specific message type. */
  on(type: string, handler: (payload: unknown) => void): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);
    return () => {
      this.messageHandlers.get(type)?.delete(handler);
    };
  }

  /** Close the connection and stop reconnecting. */
  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Whether the connection is currently open. */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private dispatch(type: string, payload: unknown): void {
    const handlers = this.messageHandlers.get(type);
    if (handlers) {
      handlers.forEach((h) => h(payload));
    }
  }

  private scheduleReconnect(): void {
    const maxAttempts = this.options.reconnectAttempts ?? 5;
    const delay = this.options.reconnectDelayMs ?? 2000;

    if (this.reconnectAttempts >= maxAttempts || this.closed) return;

    this.reconnectAttempts++;
    const backoff = delay * Math.pow(2, this.reconnectAttempts - 1);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, Math.min(backoff, 30000));
  }

  get reconnectCount(): number {
    return this.reconnectAttempts;
  }
}

/**
 * Create a WebRTC peer connection configured for low-latency audio streaming.
 * Uses UDP-based SRTP for media transport (the core of WebRTC's real-time advantage).
 */
export function createPeerConnection(config?: { iceServers?: RTCIceServer[] }): RTCPeerConnection {
  const iceServers = config?.iceServers ?? [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: "relay",
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });

  return pc;
}

/**
 * Add an audio track from a MediaStream to the peer connection for streaming.
 */
export async function addAudioTrackToPeer(
  pc: RTCPeerConnection,
  stream: MediaStream
): Promise<void> {
  const tracks = stream.getAudioTracks();
  if (tracks.length === 0) {
    throw new Error("No audio tracks found in the MediaStream");
  }
  tracks.forEach((track) => {
    pc.addTrack(track, stream);
  });
}

/**
 * Create an offer and set it as the local description.
 */
export async function createOffer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: false,
  });
  await pc.setLocalDescription(offer);
  return offer;
}

/**
 * Handle an incoming offer and create an answer.
 */
export async function handleOffer(pc: RTCPeerConnection, offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

/**
 * Handle an incoming answer.
 */
export async function handleAnswer(pc: RTCPeerConnection, answer: RTCSessionDescriptionInit): Promise<void> {
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

/**
 * Handle an incoming ICE candidate.
 */
export async function handleIceCandidate(pc: RTCPeerConnection, candidate: IceCandidate): Promise<void> {
  await pc.addIceCandidate(new RTCIceCandidate(candidate));
}

/**
 * Collect ICE candidates from the peer connection and return them as they arrive.
 */
export function collectIceCandidates(
  pc: RTCPeerConnection,
  onCandidate: (candidate: IceCandidate) => void
): () => void {
  const handler = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      onCandidate({
        candidate: event.candidate.candidate,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0,
        sdpMid: event.candidate.sdpMid ?? "",
      });
    }
  };
  pc.addEventListener("icecandidate", handler);
  return () => pc.removeEventListener("icecandidate", handler);
}
