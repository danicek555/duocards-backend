import assert from "node:assert/strict";
import test from "node:test";
import {
  bearerToken,
  createLiveGameToken,
  verifyLiveGameToken,
} from "./token.js";

const secret = "live-game-test-secret-with-at-least-thirty-two-bytes";

test("live game tokens preserve role and expire", () => {
  const token = createLiveGameToken(
    { sessionId: "session-1", role: "PLAYER", participantId: "player-1" },
    secret,
    60,
    1_000,
  );

  assert.deepEqual(verifyLiveGameToken(token, secret, 1_020), {
    version: 1,
    sessionId: "session-1",
    role: "PLAYER",
    participantId: "player-1",
    exp: 1_060,
  });
  assert.equal(verifyLiveGameToken(token, secret, 1_060), null);
  assert.equal(verifyLiveGameToken(`${token}x`, secret, 1_020), null);
});

test("bearerToken accepts only a single Bearer credential", () => {
  assert.equal(bearerToken("Bearer abc.def"), "abc.def");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken("Bearer one two"), null);
});
