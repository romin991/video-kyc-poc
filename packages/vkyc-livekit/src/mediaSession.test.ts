import assert from "node:assert/strict";
import test from "node:test";
import { publishLocalAv, releaseLiveKitRoom, type LiveKitPublication, type StoppableTrack } from "./mediaSession";

test("publishLocalAv publishes microphone then camera from getUserMedia", async () => {
  const published: Array<{ source: string; name: string }> = [];
  const mic = track("audio", "Mic");
  const cam = track("video", "Cam");
  await publishLocalAv({
    publisher: {
      publishTrack: async (mediaTrack, options) => {
        published.push(options);
        return { track: { ...mediaTrack, attach: () => undefined } };
      },
    },
    ownedTracks: [],
    isCancelled: () => false,
    devices: devices([mic, cam]),
  });

  assert.deepEqual(published, [
    { source: "microphone", name: "Mic" },
    { source: "camera", name: "Cam" },
  ]);
  assert.equal(mic.readyState, "live");
  assert.equal(cam.readyState, "live");
});

test("publishLocalAv stops tracks when the call ends after capture", async () => {
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

test("releaseLiveKitRoom disconnects, unpublishes, and stops owned tracks", async () => {
  const localMedia = track("video", "Cam");
  const nested = track("video", "nested");
  const localPublication: LiveKitPublication = {
    track: {
      stop() {
        localMedia.readyState = "ended";
      },
      readyState: "live",
      detach: () => undefined,
      mediaStreamTrack: nested,
    },
  };
  let unsubscribed = false;
  const calls: string[] = [];
  const owned = [track("audio", "early")];

  await releaseLiveKitRoom(
    {
      localParticipant: {
        trackPublications: { values: () => [localPublication] },
        unpublishTrack: async (_media, stopOnUnpublish) => {
          calls.push(`unpublish:${String(stopOnUnpublish)}`);
        },
      },
      remoteParticipants: {
        values: () => [
          {
            trackPublications: {
              values: () => [
                {
                  track: track("audio", "Remote"),
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
  assert.equal(owned[0]?.readyState, "ended");
  assert.equal(owned[1]?.readyState, "ended");
});

function track(kind: "audio" | "video", label: string): StoppableTrack {
  const value: StoppableTrack = {
    kind,
    label,
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
