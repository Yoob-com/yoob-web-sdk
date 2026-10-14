// The browser's RTCPeerConnection, which Node does not have. Only the network edge is faked: the offer/answer, ICE,
// and the remote track arriving. `YoobWebRTCConversation` itself runs unchanged.
import { FakeMediaStream, FakeTrack } from "./real-avatar";

export class FakePeerConnection {
  static all: FakePeerConnection[] = [];
  static get last(): FakePeerConnection | undefined { return FakePeerConnection.all.at(-1); }

  iceGatheringState = "complete";
  connectionState = "new";
  closed = false;
  localDescription?: { type: string; sdp: string };
  remoteDescription?: { type: string; sdp: string };
  readonly senders: FakeTrack[] = [];
  ontrack?: (event: { streams: FakeMediaStream[]; track: FakeTrack }) => void;
  onconnectionstatechange?: () => void;

  constructor() { FakePeerConnection.all.push(this); }
  createDataChannel() { return { onmessage: null as unknown, close() {} }; }
  addTrack(track: FakeTrack) { this.senders.push(track); }
  async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
  async setLocalDescription(description: { type: string; sdp: string }) { this.localDescription = description; }
  async setRemoteDescription(description: { type: string; sdp: string }) { this.remoteDescription = description; }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; this.connectionState = "closed"; }

  /** The model's side connects and its voice track arrives. */
  connect(): void {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
    const track = new FakeTrack();
    this.ontrack?.({ streams: [new FakeMediaStream([track])], track });
  }
}

export function installPeerConnection(): void {
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;
}
