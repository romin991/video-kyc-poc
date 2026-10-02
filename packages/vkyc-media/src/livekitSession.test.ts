import assert from "node:assert/strict";
import test from "node:test";
import {
  clearLiveKitTiles,
  createLiveKitReleaseGate,
  isJoinableToken,
  publishLocalAv,
  releaseLiveKitRoom,
  roomNameFor,
  type LiveKitPublication,
  type StoppableTrack,
} from "./livekitSession";

test("roomNameFor prefixes the session id", () => {
  assert.equal(roomNameFor("session-42"), "vkyc-session-42");
});

test("isJoinableToken accepts a three-segment JWT only", () => {
  assert.equal(isJoinableToken("aaa.bbb.ccc"), true);
  assert.equal(isJoinableToken("lk-stub-agent-vkyc-1"), false);
  assert.equal(isJoinableToken("a.b."), false);
  assert.equal(isJoinableToken(""), false);
});

test("publishLocalAv publishes microphone then camera from getUserMedia", async () => {
  const published: Array<{ source: string; name: string }> = [];
  const attached: string[] = [];
  const mic = track("audio", "Mic");
  const cam = track("video", "Cam");
  await publishLocalAv({
    publisher: {
      publishTrack: async (mediaTrack, options) => {
        published.push(options);
        return { track: { attach: () => attached.push(mediaTrack.label ?? "") } };
      },
    },
    ownedTracks: [],
    isCancelled: () => false,
    devices: devices([mic, cam]),
    onCameraPublished: (local) => local.attach?.(fakeElement()),
  });

  assert.deepEqual(published, [
    { source: "microphone", name: "Mic" },
    { source: "camera", name: "Cam" },
  ]);
  assert.deepEqual(attached, ["Cam"]);
  assert.equal(mic.readyState, "live");
  assert.equal(cam.readyState, "live");
});

test("publishLocalAv stops tracks when the call ends after capture and before publish", async () => {
  const mic = track("audio", "Mic");
  const cam = track("video", "Cam");
  let captured = false;
  let publishes = 0;
  await publishLocalAv({
    publisher: {
      publishTrack: async () => {
        publishes += 1;
        return {};
      },
    },
    ownedTracks: [],
    isCancelled: () => captured,
    devices: {
      ...devices([mic, cam]),
      getUserMedia: async () => {
        captured = true;
        return devices([mic, cam]).getUserMedia({ audio: true, video: true });
      },
    },
  });
  assert.equal(publishes, 0);
  assert.equal(mic.readyState, "ended");
  assert.equal(cam.readyState, "ended");
});

test("publishLocalAv throws when the browser has no inputs", async () => {
  await assert.rejects(
    () =>
      publishLocalAv({
        publisher: { publishTrack: async () => ({}) },
        ownedTracks: [],
        isCancelled: () => false,
        devices: {
          enumerateDevices: async () => [],
          getUserMedia: async () => {
            throw new Error("should not capture");
          },
        },
      }),
    /No audio\/video inputs/,
  );
});

test("releaseLiveKitRoom disconnects, unpublishes, and stops owned tracks", async () => {
  const localMedia = track("video", "Cam");
  const nested = track("video", "nested");
  const localPublication: LiveKitPublication = {
    track: {
      stop: localMedia.stop,
      readyState: "live",
      detach: () => undefined,
      mediaStreamTrack: nested,
    },
  };
  let unsubscribed = false;
  const remote = track("audio", "Remote");
  const calls: string[] = [];
  const owned = [track("audio", "early")];

  await releaseLiveKitRoom(
    {
      localParticipant: {
        trackPublications: { values: () => [localPublication] },
        unpublishTrack: async (_track, stopOnUnpublish) => {
          calls.push(`unpublish:${String(stopOnUnpublish)}`);
        },
      },
      remoteParticipants: {
        values: () => [
          {
            trackPublications: {
              values: () => [
                {
                  track: remote,
                  setSubscribed: (subscribed: boolean) => {
                    unsubscribed = subscribed === false;
                  },
                },
              ],
            },
          },
        ],
      },
      disconnect: async (stopTracks) => {
        calls.push(`disconnect:${String(stopTracks)}`);
        owned.push(track("video", "late"));
      },
      removeAllListeners: () => {
        calls.push("listeners");
      },
    },
    owned,
  );

  assert.deepEqual(calls, ["unpublish:true", "disconnect:true", "listeners"]);
  assert.equal(unsubscribed, true);
  assert.equal(localMedia.readyState, "ended");
  assert.equal(nested.readyState, "ended");
  assert.equal(remote.readyState, "live");
  assert.equal(owned[0]?.readyState, "ended");
  assert.equal(owned[1]?.readyState, "ended");
});

test("clearLiveKitTiles revokes blob urls and clears the active flag", () => {
  const revoked: string[] = [];
  const tile = {
    src: "blob:http://local/1",
    srcObject: { id: "stream" },
    removed: "",
    removeAttribute(name: string) {
      this.removed = name;
      this.src = "";
    },
    dataset: { active: "true" } as { active?: string },
  };
  clearLiveKitTiles([tile], (url) => revoked.push(url));
  assert.deepEqual(revoked, ["blob:http://local/1"]);
  assert.equal(tile.removed, "src");
  assert.equal(tile.srcObject, null);
  assert.equal("active" in tile.dataset, false);
});

test("the release gate runs the next connect after disconnect finishes", async () => {
  const gate = createLiveKitReleaseGate();
  const order: string[] = [];
  let finishRelease: () => void = () => undefined;
  gate.schedule(
    () =>
      new Promise<void>((resolve) => {
        finishRelease = () => {
          order.push("released");
          resolve();
        };
      }),
  );
  const waiting = gate.afterReleased().then(() => {
    order.push("next");
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  finishRelease();
  await waiting;
  assert.deepEqual(order, ["released", "next"]);
});

function track(kind: "audio" | "video", label: string): StoppableTrack {
  const value: StoppableTrack = {
    label: kind === "audio" ? label : label,
    readyState: "live",
    stop() {
      value.readyState = "ended";
    },
  };
  return value;
}

function devices(tracks: StoppableTrack[]) {
  return {
    enumerateDevices: async () =>
      tracks.map((media) => ({
        kind: media.label === "Mic" ? "audioinput" : "videoinput",
        label: media.label ?? "",
        deviceId: "device-123456789",
      })),
    getUserMedia: async (_constraints: { audio: boolean; video: boolean }) => ({
      getTracks: () => tracks,
      getAudioTracks: () => tracks.filter((media) => media.label === "Mic"),
      getVideoTracks: () => tracks.filter((media) => media.label !== "Mic"),
    }),
  };
}

function fakeElement(): HTMLMediaElement {
  return {} as HTMLMediaElement;
}
