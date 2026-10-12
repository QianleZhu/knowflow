import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentRunReplay } from "./agent-run-protocol.js";

const sampleEvent = { type: "agent.step.completed", step: "retrieve_knowledge" } as const;

// 构造指定序号的纯协议事件，避免回放边界测试依赖 Redis 或数据库。
function events(...sequences: number[]) {
  return sequences.map((sequence) => ({ sequence, event: sampleEvent }));
}

void describe("Agent run event replay", () => {
  void it("replays only the next contiguous events after the client cursor", () => {
    const replay = buildAgentRunReplay(events(4, 5, 6), 3, 6, 6);
    assert.equal(replay.snapshotRequired, false);
    assert.equal(replay.waitingForCheckpoint, false);
    assert.deepEqual(
      replay.events.map(({ sequence }) => sequence),
      [4, 5, 6],
    );
  });

  void it("requests a snapshot when the Redis cache lost its retained prefix", () => {
    const replay = buildAgentRunReplay(events(8, 9), 2, 9, 9);
    assert.equal(replay.snapshotRequired, true);
    assert.deepEqual(replay.events, []);
    assert.equal(replay.minSequence, 8);
  });

  void it("requests a snapshot for an interior Redis write gap", () => {
    const replay = buildAgentRunReplay(events(1, 2, 4, 5), 0, 5, 5);
    assert.equal(replay.snapshotRequired, true);
    assert.deepEqual(replay.events, []);
  });

  void it("requests a snapshot when the last cached event trails the database high watermark", () => {
    const replay = buildAgentRunReplay(events(1, 2, 3), 0, 4, 4);
    assert.equal(replay.snapshotRequired, true);
  });

  void it("replays live delta sequences beyond the persisted answer checkpoint", () => {
    const replay = buildAgentRunReplay(events(1, 2, 3, 4), 2, 2, 4);
    assert.equal(replay.snapshotRequired, false);
    assert.deepEqual(
      replay.events.map(({ sequence }) => sequence),
      [3, 4],
    );
  });

  void it("waits for the database checkpoint before repairing a recent missing event", () => {
    const replay = buildAgentRunReplay(events(1, 3), 0, 1, 3);
    assert.equal(replay.snapshotRequired, false);
    assert.equal(replay.waitingForCheckpoint, true);
    assert.deepEqual(
      replay.events.map(({ sequence }) => sequence),
      [1],
    );
  });

  void it("uses the answer snapshot once its checkpoint covers the missing event", () => {
    const replay = buildAgentRunReplay(events(1, 3), 0, 3, 3);
    assert.equal(replay.snapshotRequired, true);
    assert.deepEqual(replay.events, []);
  });

  void it("waits for a checkpoint when Redis is unavailable during unpersisted output", () => {
    const replay = buildAgentRunReplay([], 2, 2, 4);
    assert.equal(replay.snapshotRequired, false);
    assert.equal(replay.waitingForCheckpoint, true);
  });

  void it("limits batches without treating later contiguous events as cache loss", () => {
    const replay = buildAgentRunReplay(events(1, 2, 3, 4, 5), 0, 5, 5, 2);
    assert.equal(replay.snapshotRequired, false);
    assert.deepEqual(
      replay.events.map(({ sequence }) => sequence),
      [1, 2],
    );
  });

  void it("does not demand a snapshot when the client is already at the high watermark", () => {
    const replay = buildAgentRunReplay([], 7, 7, 7);
    assert.equal(replay.snapshotRequired, false);
    assert.equal(replay.minSequence, 8);
  });
});
