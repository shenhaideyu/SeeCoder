// ToolArtifact 描述外置结果的引用，ToolResult 是工具执行后的完整结构。
import type { ToolArtifact, ToolResult } from '@seecoder/protocol';
// SessionStore 提供 Artifact 的磁盘写入、读取和 Session 隔离能力。
import type { SessionStore } from '@seecoder/storage';

// ToolArtifactStore 把过大的工具结果移出模型消息，避免它们挤满上下文。
export class ToolArtifactStore {
  // store 负责真实持久化；threshold 是结果开始外置的字符阈值，默认一万六千。
  constructor(private readonly store: SessionStore, private readonly threshold = 16_000) {}

  // capture 检查工具结果大小，必要时保存 Artifact 并返回引用。
  async capture(
    // sessionId 保证大型结果只能被所属 Session 读取。
    sessionId: string,
    // toolCallId 将 Artifact 与产生它的工具调用关联起来。
    toolCallId: string,
    // toolName 供恢复时选择正确的 Observation 序列化方式。
    toolName: string,
    // result 是尚未裁剪的完整工具结果。
    result: ToolResult,
  // 小结果不外置时返回 undefined，大结果返回可持久化引用。
  ): Promise<ToolArtifact | undefined> {
    // JSON.stringify 得到实际准备保存和估算长度的文本形式。
    const serialized = JSON.stringify(result);
    // 长度没有超过阈值时保留原流程，不产生额外磁盘文件。
    if (serialized.length <= this.threshold) return undefined;
    // 大结果交给 SessionStore 写入，并把生成的引用返回调用方。
    return this.store.writeArtifact(sessionId, toolCallId, toolName, serialized);
  } // 结束 Artifact 捕获方法。

  // read 按引用读取 Artifact 的一个区间，避免一次重新加载全部大文件。
  async read(sessionId: string, artifactRef: string, offset?: number, limit?: number) {
    // SessionStore 会校验引用属于当前 Session，并应用 offset/limit 分页。
    return this.store.readArtifact(sessionId, artifactRef, offset, limit);
  } // 结束 Artifact 读取方法。
} // 结束 ToolArtifactStore 类。
