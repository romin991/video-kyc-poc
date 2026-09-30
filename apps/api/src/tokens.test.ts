import assert from "node:assert/strict";
import test from "node:test";
import { TokenVerifier } from "livekit-server-sdk";
import { participantToken, placeholderParticipantToken } from "./tokens.js";

const credentials = {
  apiKey: "devkey",
  apiSecret: "secretsecretsecretsecretsecret12",
};

test("missing LiveKit credentials return a non-connecting token", async () => {
  const roomName = "vkyc-unconfigured";
  assert.equal(
    await participantToken("agent", roomName, {}),
    placeholderParticipantToken("agent", roomName),
  );
  assert.equal(
    await participantToken("customer", roomName, { apiKey: "devkey", apiSecret: "  " }),
    placeholderParticipantToken("customer", roomName),
  );
});

test("participantToken mints a 10 minute room-join JWT", async () => {
  const roomName = "vkyc-mint";
  const token = await participantToken("agent", roomName, credentials);
  const claims = await new TokenVerifier(credentials.apiKey, credentials.apiSecret).verify(token);

  assert.equal(claims.iss, credentials.apiKey);
  assert.equal(claims.sub, "agent");
  assert.equal(claims.video?.room, roomName);
  assert.equal(claims.video?.roomJoin, true);
  assert.equal(claims.video?.canPublish, true);
  assert.equal(claims.video?.canSubscribe, true);
  assert.equal(typeof claims.exp, "number");
  assert.equal(typeof claims.nbf, "number");
  const ttl = Number(claims.exp) - Number(claims.nbf);
  assert.ok(ttl >= 540 && ttl <= 660, `expected ~600s ttl, got ${ttl}`);
});

test("the same participant and room reuse a token until it is near expiry", async () => {
  const roomName = "vkyc-cache";
  const first = await participantToken("customer", roomName, credentials);
  const second = await participantToken("customer", roomName, credentials);
  const agent = await participantToken("agent", roomName, credentials);

  assert.equal(first, second);
  assert.notEqual(agent, first);
  const claims = await new TokenVerifier(credentials.apiKey, credentials.apiSecret).verify(first);
  assert.equal(claims.sub, "customer");
  assert.equal(claims.video?.room, roomName);
});
