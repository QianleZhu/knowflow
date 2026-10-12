import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getAgentRunReconnectDelay,
  isAgentRunTerminal,
  SseFrameDecoder,
} from "./agent-run-stream.js";

void describe("Agent run SSE framing", () => {
  void it("parses chunked CRLF frames, multi-line data, ids, and heartbeats", () => {
    const decoder = new SseFrameDecoder();
    assert.deepEqual(decoder.feed(": heartbeat 1\r"), []);
    assert.deepEqual(decoder.feed('\n\r\ndata: {"a":\r\ndata: 1}\r\nid: 7\r\n\r\n'), [
      { data: null, id: null },
      { data: '{"a":\n1}', id: "7" },
    ]);
  });

  void it("dispatches a final frame at EOF and bounds exponential retry delay", () => {
    const decoder = new SseFrameDecoder();
    assert.deepEqual(decoder.feed("data: terminal"), []);
    assert.deepEqual(decoder.flush(), [{ data: "terminal", id: null }]);
    assert.equal(getAgentRunReconnectDelay(0, 0), 1_000);
    assert.equal(getAgentRunReconnectDelay(0, 1), 2_000);
    assert.equal(getAgentRunReconnectDelay(100, 1), 15_000);
    assert.equal(isAgentRunTerminal("cancelled"), true);
    assert.equal(isAgentRunTerminal("running"), false);
  });
});
