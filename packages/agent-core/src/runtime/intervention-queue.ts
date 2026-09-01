// randomUUID 为每条用户干预生成不会与其他干预冲突的标识。
import { randomUUID } from 'node:crypto';

// InterventionKind 区分立即影响当前 Turn 的 steering 和任务结束后执行的 followUp。
export type InterventionKind = 'steering' | 'followUp';
// InterventionStatus 记录干预仍在等待、已被消费还是已被丢弃。
export type InterventionStatus = 'pending' | 'consumed' | 'discarded';

// Intervention 是一条运行中用户干预的完整记录。
export interface Intervention {
  // id 用于事件追踪和界面去重。
  id: string;
  // turnId 指明这条干预属于哪个正在运行的 Turn。
  turnId: string;
  // kind 决定 TurnRunner 在当前循环还是结束后处理它。
  kind: InterventionKind;
  // text 是用户希望 Agent 采用的新要求。
  text: string;
  // createdAt 保存进入队列的准确时间。
  createdAt: string;
  // status 防止同一条干预被重复消费。
  status: InterventionStatus;
} // 结束用户干预接口。

// InterventionQueue 只管理干预的顺序和状态，真正注入模型历史的时机由 TurnRunner 决定。
export class InterventionQueue {
  // entries 按 turnId 分组，保证不同 Turn 的干预不会串线。
  private readonly entries = new Map<string, Intervention[]>();

  // enqueue 校验并追加一条新的待处理干预。
  enqueue(turnId: string, kind: InterventionKind, text: string): Intervention {
    // entry 是即将写入当前 Turn 队列的规范化记录。
    const entry: Intervention = {
      // 每次入队都生成新的唯一标识。
      id: randomUUID(),
      // 保存调用方传入的目标 Turn。
      turnId,
      // 保存 steering 或 followUp 类型。
      kind,
      // 去掉首尾空白并限制一万字符，防止干预无限占用上下文。
      text: text.trim().slice(0, 10_000),
      // 使用 ISO 时间，便于持久化事件排序和展示。
      createdAt: new Date().toISOString(),
      // 新记录尚未被 TurnRunner 读取，所以初始为 pending。
      status: 'pending',
    }; // 完成干预记录构造。
    // 规范化后没有正文时立即报错，避免队列中出现无意义消息。
    if (!entry.text) throw new Error('干预内容不能为空');
    // 读取 Turn 现有数组；第一次干预时创建空数组。
    const current = this.entries.get(turnId) ?? [];
    // push 保持用户干预到达的先后顺序。
    current.push(entry);
    // 把更新后的数组写回 Map；新数组和旧数组两种情况都能正确保存。
    this.entries.set(turnId, current);
    // 返回完整记录，调用方可立即发布 intervention.queued 事件。
    return entry;
  } // 结束入队方法。

  // has 判断某个 Turn 是否还有指定类型的待处理干预。
  has(turnId: string, kind: InterventionKind): boolean {
    // some 找到第一条类型相同且状态为 pending 的记录后立即返回 true。
    return (this.entries.get(turnId) ?? []).some((entry) => entry.kind === kind && entry.status === 'pending');
  } // 结束待处理检查。

  // consume 取出指定类型的全部待处理干预，并一次性标记为已消费。
  consume(turnId: string, kind: InterventionKind): Intervention[] {
    // filter 保持原顺序，只选择类型和状态都匹配的记录。
    const matches = (this.entries.get(turnId) ?? []).filter(
      // 既要匹配 steering/followUp，也要排除已处理记录。
      (entry) => entry.kind === kind && entry.status === 'pending',
    ); // 完成待消费记录筛选。
    // 在返回前更新状态，防止下一轮再次取到同一批记录。
    for (const entry of matches) entry.status = 'consumed';
    // 返回已按入队顺序排列的匹配记录。
    return matches;
  } // 结束消费方法。

  // discard 在 Turn 结束或取消时丢弃所有尚未处理的干预。
  discard(turnId: string): Intervention[] {
    // 只筛选 pending，已消费记录保留原状态用于事件说明。
    const pending = (this.entries.get(turnId) ?? []).filter((entry) => entry.status === 'pending');
    // 逐条改为 discarded，明确它们不是正常消费完成。
    for (const entry of pending) entry.status = 'discarded';
    // 返回被丢弃的记录，TurnRunner 会为它们发布事件。
    return pending;
  } // 结束丢弃方法。

  // clear 在 Turn 完全收尾后删除整组记录，释放内存。
  clear(turnId: string): void {
    // Map.delete 同时清除 consumed、discarded 和剩余 pending 记录。
    this.entries.delete(turnId);
  } // 结束清理方法。
} // 结束 InterventionQueue 类。
