import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFilePeerRuntime } from "../filePeerRuntime.js";

/** Just enough of RTCPeerConnection for `offer()` to open the RPC channel. */
interface FakeChannel {
  label: string;
  readyState: string;
  sent: unknown[];
  onmessage?: (event: { data: unknown }) => void;
  send(data: unknown): void;
  close(): void;
}
const channels: FakeChannel[] = [];
class FakePeerConnection {
  localDescription = { sdp: "v=0" };
  iceGatheringState = "complete";
  signalingState = "stable";
  createDataChannel(label: string) {
    const channel: FakeChannel = {
      label,
      readyState: "open",
      sent: [],
      send(data) {
        this.sent.push(data);
      },
      close() {},
    };
    channels.push(channel);
    return channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  channels.length = 0;
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("restarts the deadline of queued body requests whenever an earlier one is answered", async () => {
  const runtime = createFilePeerRuntime({
    read: async () => "",
    write: async () => {},
  });
  await runtime.offer("peer", [], true);
  const rpc = channels.find((channel) => channel.label === "reads-v1")!;
  const block = btoa("x".repeat(100));
  const settled: string[] = [];
  const requests = [1, 2, 3].map((n) =>
    runtime.invoke("peer", `block-${n}`, 45_000, block).then(
      () => settled.push(`ok-${n}`),
      (error: Error) => settled.push(`${error.message}-${n}`),
    ),
  );
  await Promise.resolve();
  const keys = rpc.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame).key as string);
  expect(keys).toEqual(["1", "2", "3"]);
  const answer = (key: string) =>
    rpc.onmessage!({
      data: JSON.stringify({ key, response: true, data: "ok", last: true }),
    });
  // A slow but live link: each block takes 30–40 s on the wire, so the last one finishes
  // 100 s after all three were queued — far past a 45 s deadline counted from the queueing.
  await vi.advanceTimersByTimeAsync(30_000);
  answer("1");
  await vi.advanceTimersByTimeAsync(30_000);
  answer("2");
  await vi.advanceTimersByTimeAsync(40_000);
  answer("3");
  await Promise.all(requests);
  expect(settled).toEqual(["ok-1", "ok-2", "ok-3"]);
});

it("still times out a block when nothing is answered for the whole deadline", async () => {
  const runtime = createFilePeerRuntime({
    read: async () => "",
    write: async () => {},
  });
  await runtime.offer("peer", [], true);
  const stalled = runtime.invoke("peer", "block", 45_000, btoa("x")).catch((e: Error) => e.message);
  await vi.advanceTimersByTimeAsync(45_001);
  expect(await stalled).toBe("FILE_PEER_TIMEOUT");
});
