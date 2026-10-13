import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIVE_HOSTS, isAllowedLiveUrl } from "../src/webrtc-conversation";

test("a full-mode conversation is only opened where Yoob minted the grant", () => {
  assert.ok(isAllowedLiveUrl("https://la.yoob.com/api/v1/live/webrtc"));
  assert.ok(isAllowedLiveUrl("https://yoob.com/api/v1/live/webrtc"));
  // Running the console yourself has to work, or the demo cannot.
  assert.ok(isAllowedLiveUrl("http://localhost:3000/api/v1/live/webrtc"));
  assert.ok(isAllowedLiveUrl("http://127.0.0.1:3000/api/v1/live/webrtc"));

  // A backend that has been tampered with cannot send the microphone elsewhere.
  assert.ok(!isAllowedLiveUrl("https://yoob.com.evil.example/api/v1/live/webrtc"));
  assert.ok(!isAllowedLiveUrl("https://evil.example/api/v1/live/webrtc"));
  assert.ok(!isAllowedLiveUrl("http://la.yoob.com/api/v1/live/webrtc"), "plain http off localhost");
  assert.ok(!isAllowedLiveUrl("https://user:pass@la.yoob.com/x"), "credentials in the url");
  assert.ok(!isAllowedLiveUrl("not a url"));

  // The default is the one that matters; an override is for a self-hosted console.
  assert.deepEqual(DEFAULT_LIVE_HOSTS, ["*.yoob.com"]);
  assert.ok(isAllowedLiveUrl("https://console.example.com/x", ["console.example.com"]));
  assert.ok(!isAllowedLiveUrl("https://la.yoob.com/x", ["console.example.com"]));
});
