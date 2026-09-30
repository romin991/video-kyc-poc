import assert from "node:assert/strict";
import test from "node:test";
import {
  clearLiveKitTiles,
  createCallTape,
  createLiveKitReleaseGate,
  releaseLiveKitRoom,
  type LiveKitRoomRelease,
  type StoppableTrack,
} from "./callMediaRelease.js";

class FakeTrack implements StoppableTrack {
  readyState = "live";
  detached = false;
  mediaStreamTrack?: StoppableTrack | null;

  constructor(readonly id: string) {}

  stop(): void {
    this.readyState = "ended";
  }

  detach(): void {
    this.detached = true;
  }
}

test("release stops local tracks, unsubscribes, disconnects, and drops listeners", async () => {
  const camera = new FakeTrack("camera");
  const mic = new FakeTrack("mic");
  const remote = new FakeTrack("remote");
  const events: string[] = [];
  let stopOnUnpublish: boolean | undefined;
  const room: LiveKitRoomRelease = {
    localParticipant: {
      trackPublications: {
        values: () => [{ track: camera }, { track: mic }],
      },
      unpublishTrack: async (track, stop) => {
        stopOnUnpublish = stop;
        events.push(`unpublish:${(track as FakeTrack).id}`);
      },
    },
    remoteParticipants: {
      values: () => [
        {
          trackPublications: {
            values: () => [
              {
                track: remote,
                setSubscribed: (subscribed) => {
                  events.push(`subscribed:${subscribed}`);
                },
              },
            ],
          },
        },
      ],
    },
    disconnect: async (stopTracks) => {
      events.push(`disconnect:${stopTracks}`);
    },
    removeAllListeners: () => {
      events.push("listeners");
    },
  };

  await releaseLiveKitRoom(room, [camera, mic]);

  assert.equal(camera.readyState, "ended");
  assert.equal(mic.readyState, "ended");
  assert.equal(camera.detached, true);
  assert.equal(remote.detached, true);
  assert.equal(remote.readyState, "live");
  assert.equal(stopOnUnpublish, true);
  assert.deepEqual(events, [
    "unpublish:camera",
    "unpublish:mic",
    "subscribed:false",
    "disconnect:true",
    "listeners",
  ]);
});

test("release stops a getUserMedia track that appears during disconnect", async () => {
  const late = new FakeTrack("late");
  const owned: StoppableTrack[] = [];
  const room: LiveKitRoomRelease = {
    localParticipant: {
      trackPublications: { values: () => [] },
      unpublishTrack: async () => undefined,
    },
    remoteParticipants: { values: () => [] },
    disconnect: async () => {
      owned.push(late);
    },
    removeAllListeners: () => undefined,
  };

  await releaseLiveKitRoom(room, owned);

  assert.equal(late.readyState, "ended");
});

test("release still drops listeners when disconnect fails", async () => {
  let listeners = 0;
  const camera = new FakeTrack("camera");
  const room: LiveKitRoomRelease = {
    localParticipant: {
      trackPublications: { values: () => [{ track: camera }] },
      unpublishTrack: async () => {
        throw new Error("already unpublished");
      },
    },
    remoteParticipants: { values: () => [] },
    disconnect: async () => {
      throw new Error("socket closed");
    },
    removeAllListeners: () => {
      listeners += 1;
    },
  };

  await releaseLiveKitRoom(room, [camera]);

  assert.equal(camera.readyState, "ended");
  assert.equal(listeners, 1);
});

test("clearing tiles revokes blob URLs and leaves https sources alone", () => {
  const revoked: string[] = [];
  const blobTile = {
    src: "blob:http://127.0.0.1/call",
    srcObject: { id: "stream" },
    removed: [] as string[],
    removeAttribute(name: string) {
      this.removed.push(name);
      this.src = "";
    },
    dataset: { active: "true" },
  };
  const httpsTile = {
    src: "https://cdn.example/call.mp4",
    srcObject: { id: "remote" },
    removed: [] as string[],
    removeAttribute(name: string) {
      this.removed.push(name);
    },
    dataset: { active: "true" },
  };

  clearLiveKitTiles([blobTile, httpsTile], (url) => revoked.push(url));

  assert.deepEqual(revoked, ["blob:http://127.0.0.1/call"]);
  assert.deepEqual(blobTile.removed, ["src"]);
  assert.equal(blobTile.srcObject, null);
  assert.equal("active" in blobTile.dataset, false);
  assert.deepEqual(httpsTile.removed, []);
  assert.equal(httpsTile.src, "https://cdn.example/call.mp4");
  assert.equal(httpsTile.srcObject, null);
  assert.equal("active" in httpsTile.dataset, false);
});

test("stopping the fallback recorder revokes object URLs once", async () => {
  const chunks = [new Blob(["frame"])];
  let closes = 0;
  const revoked: string[] = [];
  const recorder = {
    state: "recording",
    mimeType: "video/webm",
    onstop: null as (() => void) | null,
    onerror: null as (() => void) | null,
    stop() {
      this.state = "inactive";
      this.onstop?.();
    },
  };
  const tape = createCallTape({
    recorder,
    chunks,
    close: () => {
      closes += 1;
    },
    objectUrls: ["blob:http://127.0.0.1/tape", "https://cdn.example/keep.mp4"],
    revokeObjectURL: (url) => revoked.push(url),
  });

  const blob = await tape.stop();
  assert.equal(blob.size > 0, true);
  assert.equal(blob.type, "video/webm");
  assert.deepEqual(revoked, ["blob:http://127.0.0.1/tape"]);
  assert.equal(closes, 1);

  const again = await tape.stop();
  assert.equal(again, blob);
  assert.equal(closes, 1);
  assert.deepEqual(revoked, ["blob:http://127.0.0.1/tape"]);
});

test("an inactive recorder closes without calling stop", async () => {
  let stops = 0;
  let closes = 0;
  const tape = createCallTape({
    recorder: {
      state: "inactive",
      mimeType: "",
      onstop: null,
      onerror: null,
      stop() {
        stops += 1;
      },
    },
    chunks: [],
    close: () => {
      closes += 1;
    },
  });

  const blob = await tape.stop();
  assert.equal(blob.size, 0);
  assert.equal(blob.type, "video/webm");
  assert.equal(stops, 0);
  assert.equal(closes, 1);
});

test("the next connect waits until the previous room release finishes", async () => {
  const gate = createLiveKitReleaseGate();
  const order: string[] = [];
  let finishFirst: () => void = () => undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });

  gate.schedule(async () => {
    order.push("release-start");
    await firstBlocked;
    order.push("release-end");
  });

  let secondFinished = false;
  const waiting = gate.afterReleased().then(() => {
    secondFinished = true;
    order.push("next-connect");
  });

  await Promise.resolve();
  assert.equal(secondFinished, false);
  assert.deepEqual(order, ["release-start"]);

  finishFirst();
  await waiting;
  assert.deepEqual(order, ["release-start", "release-end", "next-connect"]);
});

test("a failed release does not block the next room", async () => {
  const gate = createLiveKitReleaseGate();
  gate.schedule(async () => {
    throw new Error("socket closed");
  });
  let ran = false;
  gate.schedule(async () => {
    ran = true;
  });
  await gate.afterReleased();
  assert.equal(ran, true);
});
