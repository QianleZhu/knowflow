import type { AskStreamEvent } from "@knowflow/shared";

export type SequencedAgentRunEvent = { sequence: number; event: AskStreamEvent };
export type AgentRunReplay = {
  snapshotRequired: boolean;
  waitingForCheckpoint: boolean;
  minSequence: number;
  events: SequencedAgentRunEvent[];
};

// 区分 Redis 实时事件高水位与数据库正文快照高水位，避免快照尚未覆盖时误跳过 delta。
export function buildAgentRunReplay(
  events: SequencedAgentRunEvent[],
  afterSequence: number,
  checkpointSequence: number,
  lastSequence: number,
  maxEvents = 100,
): AgentRunReplay {
  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
  const minSequence = orderedEvents[0]?.sequence ?? lastSequence + 1;
  const pending = orderedEvents.filter(({ sequence }) => sequence > afterSequence);
  const replayEvents: SequencedAgentRunEvent[] = [];
  let expectedSequence = afterSequence + 1;
  let snapshotRequired = false;
  let waitingForCheckpoint = false;

  // 如果 Redis 已裁剪前缀，只有数据库快照覆盖到了缺失范围才允许客户端跳到快照。
  if (afterSequence + 1 < minSequence) {
    const missingThroughSequence = minSequence - 1;
    if (missingThroughSequence <= checkpointSequence) snapshotRequired = true;
    else waitingForCheckpoint = true;
  }

  for (const item of pending) {
    if (item.sequence < expectedSequence) continue;
    if (item.sequence > expectedSequence) {
      // 未落入正文快照的缺口先等待 checkpoint；已被快照覆盖的缺口改走快照恢复。
      if (expectedSequence <= checkpointSequence) snapshotRequired = true;
      else waitingForCheckpoint = true;
      break;
    }
    replayEvents.push(item);
    expectedSequence += 1;
    if (replayEvents.length >= maxEvents) break;
  }

  // Redis 尾部事件暂时未写入或缺失时，等待快照追上后再要求客户端回退恢复。
  if (!snapshotRequired && replayEvents.length < maxEvents && expectedSequence <= lastSequence) {
    if (expectedSequence <= checkpointSequence) snapshotRequired = true;
    else waitingForCheckpoint = true;
  }

  return {
    snapshotRequired,
    waitingForCheckpoint,
    minSequence,
    events: snapshotRequired ? [] : replayEvents,
  };
}
