// randomUUID 为 ChangeSet、Checkpoint 和持久化 Item 生成唯一标识。
import { randomUUID } from 'node:crypto';
// readFile 在恢复 Checkpoint 前读取当前磁盘内容，用于检测用户后续修改。
import { readFile } from 'node:fs/promises';
// 导入变更管理需要发布和保存的共享协议类型。
import type { AgentEvent, ChangeSet, Checkpoint, Item, ToolResult, Turn } from '@seecoder/protocol';
// SessionStore 保存修改前快照和变更生命周期事件。
import type { SessionStore } from '@seecoder/storage';
// restoreChangeSet 执行真实恢复，WorkspacePolicy 保证路径仍在 Workspace 内。
import { restoreChangeSet, type WorkspacePolicy } from '@seecoder/tools';
// ContextLedger 记录代码 revision，FileEvidenceStore 缓存已读取文件证据。
import type { ContextLedger, FileEvidenceStore } from '../context.js';
// fail 构造标准错误结果，hash 用来判断文件是否仍保持检查点状态。
import { fail, hash } from './policy.js';
// 写入协调器保证恢复操作不会与其他 Session 的文件写入并发冲突。
import type { WorkspaceMutationCoordinator } from './workspace-mutation-coordinator.js';

// now 生成事件和记录统一使用的 ISO 时间。
const now = () => new Date().toISOString();
// itemId 为伴随事件持久化的业务 Item 生成唯一标识。
const itemId = () => randomUUID();

// ChangeManagerOptions 列出变更管理器需要的全部外部依赖。
interface ChangeManagerOptions {
  // workspace 是 restoreChangeSet 真正读写文件的项目根目录。
  workspace: string;
  // policy 在 Checkpoint 恢复前把相对路径限制在当前 Workspace。
  policy: WorkspacePolicy;
  // store 保存事件、ChangeSet Item 和修改前 Snapshot。
  store: SessionStore;
  // emit 统一持久化并广播变更与检查点事件。
  emit: (event: AgentEvent, item?: Item) => Promise<void>;
  // persistLedger 在 revision 或验证状态变化后把账本写入磁盘。
  persistLedger: (sessionId: string) => Promise<void>;
  // getLedger 返回指定 Session 当前的权威任务账本。
  getLedger: (sessionId: string) => ContextLedger | undefined;
  // getEvidence 返回指定 Session 的文件证据缓存。
  getEvidence: (sessionId: string) => FileEvidenceStore | undefined;
  // getTurnSession 为旧 ChangeSet 缺少 sessionId 时从 turnId 反查 Session。
  getTurnSession: (turnId: string) => string | undefined;
  // mutations 与工具执行共享同一组 Workspace 文件锁。
  mutations: WorkspaceMutationCoordinator;
} // 结束变更管理器依赖接口。

// ChangeManager 管理一次工具修改形成的 ChangeSet 和可安全恢复的 Checkpoint。
export class ChangeManager {
  // changeSets 以 id 建立 O(1) 内存索引，值中保存每个文件 before/after。
  private readonly changeSets = new Map<string, ChangeSet>();
  // checkpoints 以 id 保存恢复点及对应文件哈希。
  private readonly checkpoints = new Map<string, Checkpoint>();

  // 构造函数保存依赖，实际数据由新修改或 Session 回放逐步填充。
  constructor(private readonly options: ChangeManagerOptions) {}

  // hydrate 在 Session 恢复时把事件回放得到的记录重新装入索引。
  hydrate(changeSets: ChangeSet[], checkpoints: Checkpoint[]): void {
    // 以 id 覆盖写入，使重复回放不会产生重复 ChangeSet。
    for (const changeSet of changeSets) this.changeSets.set(changeSet.id, changeSet);
    // 先装入历史 Checkpoint；下面会把旧版“每次写入一个恢复点”归并为“一轮一个恢复点”。
    for (const checkpoint of checkpoints) this.checkpoints.set(checkpoint.id, checkpoint);
    // grouped 按 turnId 收集内存中的全部恢复点，兼容旧 Session 多次 hydrate。
    const grouped = new Map<string, Checkpoint[]>();
    // 遍历当前索引，而不只处理本次参数，避免分批加载时留下重复恢复点。
    for (const checkpoint of this.checkpoints.values()) {
      // 取得同一 Turn 已收集的恢复点数组。
      const group = grouped.get(checkpoint.turnId) ?? [];
      // 保存当前恢复点，稍后统一选出一个稳定 id。
      group.push(checkpoint);
      // 把更新后的数组写回 Map。
      grouped.set(checkpoint.turnId, group);
    }
    // 清空旧索引，随后每个 Turn 只写回一个聚合结果。
    this.checkpoints.clear();
    // 逐 Turn 归并旧版检查点。
    for (const group of grouped.values()) {
      // Map 保留事件装入顺序；使用最后一条旧记录的 id，让 Renderer 历史中的最后一个恢复点仍能命中它。
      const latest = group[group.length - 1]!;
      // 找到该 Turn 的全部 ChangeSet，重新计算真正覆盖整轮的文件状态。
      const turnChanges = this.changeSetsForTurn(latest.turnId);
      // 没有 ChangeSet 的旧手动标记没有可恢复内容，只保留一条以维持兼容。
      const normalized = turnChanges.length
        ? this.buildCheckpoint(latest.sessionId, latest.turnId, turnChanges, latest.id, latest.createdAt)
        : latest;
      // 每个 turnId 只写回一个 Checkpoint。
      this.checkpoints.set(normalized.id, normalized);
    }
  } // 结束变更索引恢复方法。

  // changeSetsForTurn 返回一个 Turn 的全部变更；Map 插入顺序就是工具真实完成顺序。
  private changeSetsForTurn(turnId: string): ChangeSet[] {
    // 不按毫秒时间排序：同一毫秒内可能有多次写入，重新排序会破坏因果顺序。
    return [...this.changeSets.values()].filter((changeSet) => changeSet.turnId === turnId);
  } // 结束 Turn ChangeSet 查询。

  // buildCheckpoint 把多次工具修改压成“Turn 开始前 → Turn 结束后”的单一恢复边界。
  private buildCheckpoint(
    sessionId: string,
    turnId: string,
    changeSets: ChangeSet[],
    id: string = randomUUID(),
    createdAt = now(),
  ): Checkpoint {
    // fileStates 让每个路径只保留最早 before 与最新 after。
    const fileStates = new Map<string, { before: string | null; after: string | null }>();
    // ChangeSet 已按时间排序，因此第一次出现代表本轮初始状态，最后一次出现代表终态。
    for (const changeSet of changeSets) {
      // 一个 ChangeSet 可以同时包含多个文件，逐个合并。
      for (const file of changeSet.files) {
        // existing 存在时保留最早 before，只更新最新 after。
        const existing = fileStates.get(file.path);
        // 写入该路径聚合后的首尾内容。
        fileStates.set(file.path, { before: existing ? existing.before : file.before, after: file.after });
      }
    }
    // 返回协议层 Checkpoint；正文仍保存在 ChangeSet，恢复点只存哈希和引用。
    return {
      id,
      sessionId,
      turnId,
      changeSetIds: changeSets.map((changeSet) => changeSet.id),
      files: [...fileStates.entries()].map(([path, state]) => ({
        path,
        beforeHash: hash(state.before),
        afterHash: hash(state.after),
      })),
      createdAt,
    };
  } // 结束 Turn Checkpoint 聚合。

  // removeSession 删除一个 Session 时同步清理它的内存变更索引。
  removeSession(sessionId: string): void {
    // 遍历全部 ChangeSet，删除明确属于目标 Session 的记录。
    for (const [id, changeSet] of this.changeSets) if (changeSet.sessionId === sessionId) this.changeSets.delete(id);
    // 遍历全部 Checkpoint，删除属于目标 Session 的记录。
    for (const [id, checkpoint] of this.checkpoints) if (checkpoint.sessionId === sessionId) this.checkpoints.delete(id);
  } // 结束 Session 变更清理方法。

  // revert 把一个 ChangeSet 中的文件恢复为该工具调用执行前的内容。
  async revert(changeSetId: string): Promise<ToolResult> {
    // 先用用户或 UI 提供的 id 查找完整 before/after 记录。
    const changeSet = this.changeSets.get(changeSetId);
    // 找不到时返回结构化失败，不抛出无法解释的 Map 空值错误。
    if (!changeSet) return fail('changes_not_found', '找不到可撤销的 ChangeSet');
    // runExclusive 一次锁住本 ChangeSet 涉及的全部路径，避免恢复到一半被其他写入穿插。
    const result = await this.options.mutations.runExclusive(
      // map 提取恢复工具真正会写入的相对路径。
      changeSet.files.map((file) => file.path),
      // restoreChangeSet 根据 before 内容恢复创建、修改和删除三类变化。
      () => restoreChangeSet(this.options.workspace, changeSet.files),
    ); // 等待事务恢复完成并取得统一 ToolResult。
    // 只有磁盘恢复成功后才能更新 Ledger、Evidence 和事件。
    if (result.ok) {
      // 新记录直接有 sessionId；旧记录通过 turnId 兼容反查。
      const sessionId = changeSet.sessionId ?? this.options.getTurnSession(changeSet.turnId);
      // 找到所属 Session 时同步更新其上下文状态。
      if (sessionId) {
        // 文件内容已经改变，先让这些路径的旧读取证据失效。
        this.options.getEvidence(sessionId)?.invalidate(changeSet.files.map((file) => file.path));
        // 把恢复后的 before 当作一次新变化记录，Ledger revision 因此继续增加。
        this.options.getLedger(sessionId)?.recordChanges(changeSet.files.map((file) => ({ path: file.path, after: file.before })));
        // revision 更新后立即写入 state.json，应用崩溃也能恢复一致账本。
        await this.options.persistLedger(sessionId);
      } // 结束 Session 上下文同步。
      // 发布 changes.reverted；有 sessionId 时显式加入路由字段。
      await this.options.emit({ type: 'changes.reverted', timestamp: now(), changeSetId, ...(sessionId ? { sessionId } : {}) });
    } // 结束成功恢复后的记账和事件处理。
    // 返回真实恢复结果，让 UI 知道成功或具体文件错误。
    return result;
  } // 结束 ChangeSet 撤销方法。

  // listCheckpoints 返回检查点副本，并支持按 Session 过滤。
  listCheckpoints(sessionId?: string): Checkpoint[] {
    // 先展开 Map 值，再过滤 Session，最后按创建时间从新到旧排序。
    return [...this.checkpoints.values()].filter((item) => !sessionId || item.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } // 结束检查点列表方法。

  // restore 先验证当前文件未被用户再次修改，再恢复检查点包含的 ChangeSet。
  async restore(checkpointId: string): Promise<ToolResult> {
    // 通过 id 获取检查点的文件哈希和 ChangeSet 列表。
    const checkpoint = this.checkpoints.get(checkpointId);
    // 不存在时返回稳定错误，避免进入空恢复流程。
    if (!checkpoint) return fail('checkpoint_not_found', '找不到检查点');
    // 一次锁住检查点全部文件，使冲突检查和恢复之间没有并发写入窗口。
    return this.options.mutations.runExclusive(checkpoint.files.map((file) => file.path), async () => {
      // 逐个确认磁盘仍处于 Checkpoint 创建后的状态。
      for (const file of checkpoint.files) {
        // policy.path 解析并拒绝任何跳出 Workspace 的记录路径。
        const target = await this.options.policy.path(file.path);
        // current 使用 null 表示文件当前不存在，与 ChangeSet 删除语义一致。
        let current: string | null = null;
        // 正常文件读为 UTF-8；不存在或读取失败统一保留 null。
        try { current = await readFile(target, 'utf8'); } catch { current = null; }
        // afterHash 是 Agent 修改完成时的状态；不同说明用户或其他进程又改过文件。
        if (hash(current) !== file.afterHash) return fail('checkpoint_conflict', `文件 ${file.path} 已发生变化，无法安全恢复`);
      } // 所有文件哈希检查完成后才进入真实恢复。
      // results 收集每个 ChangeSet 的恢复结果，用于发现首个失败。
      const results: ToolResult[] = [];
      // 必须逆序恢复：同一文件若先从 A 改到 B、再从 B 改到 C，应先 C→B，再 B→A。
      for (const id of [...checkpoint.changeSetIds].reverse()) {
        // 从内存索引取出完整文件 before/after。
        const changeSet = this.changeSets.get(id);
        // 找到记录时恢复；缺失旧记录时跳过，避免 undefined 访问。
        if (changeSet) results.push(await restoreChangeSet(this.options.workspace, changeSet.files));
      } // 结束检查点 ChangeSet 恢复循环。
      // find 返回第一个 ok=false 的结果。
      const failed = results.find((item) => !item.ok);
      // 任一恢复失败时直接返回，不发布成功事件或更新账本。
      if (failed) return failed;
      // restoredFiles 提取需要失效的全部文件证据路径。
      const restoredFiles = checkpoint.files.map((file) => file.path);
      // 恢复后的磁盘内容与旧 Evidence 不同，必须清除缓存。
      this.options.getEvidence(checkpoint.sessionId)?.invalidate(restoredFiles);
      // restoredByPath 只保留每个文件在本轮最早的 before，避免 Ledger 停在中间版本。
      const restoredByPath = new Map<string, string | null>();
      // changeSetIds 是正序；同一路径第一次出现就是用户发起本轮前的内容。
      for (const id of checkpoint.changeSetIds) {
        // 逐文件登记最早状态，后续同路径修改不覆盖它。
        for (const file of this.changeSets.get(id)?.files ?? []) if (!restoredByPath.has(file.path)) restoredByPath.set(file.path, file.before);
      }
      // 转成 ContextLedger.recordChanges 需要的数组结构。
      const restoredChanges = [...restoredByPath.entries()].map(([path, after]) => ({ path, after }));
      // 至少恢复一个文件时才增加 Ledger revision。
      if (restoredChanges.length) this.options.getLedger(checkpoint.sessionId)?.recordChanges(restoredChanges);
      // 把新的 Ledger 状态写入所属 Session。
      await this.options.persistLedger(checkpoint.sessionId);
      // 发布恢复成功事件，包含 Checkpoint、Turn 和 Session 路由信息。
      await this.options.emit({ type: 'checkpoint.restored', timestamp: now(), checkpointId, turnId: checkpoint.turnId, sessionId: checkpoint.sessionId });
      // turn.reverted 是追加式 tombstone：历史和模型上下文会删除这整个 Turn，但原始轨迹仍可审计。
      await this.options.emit({ type: 'turn.reverted', timestamp: now(), turnId: checkpoint.turnId, checkpointId, sessionId: checkpoint.sessionId });
      // 返回恢复范围和所属 Session，AgentCore 据此立即重建内存派生状态。
      return { ok: true, output: { checkpointId, restored: checkpoint.changeSetIds, turnId: checkpoint.turnId, sessionId: checkpoint.sessionId }, durationMs: 0 };
    }); // runExclusive 在回调结束后自动释放全部文件锁。
  } // 结束检查点恢复方法。

  // record 在工具成功修改文件后创建 ChangeSet 和 Snapshot；恢复点延迟到 Turn 终态统一创建。
  async record(turn: Turn, files: Array<{ path: string; before: string | null; after: string | null }>): Promise<void> {
    // changeSet 保存一次工具调用造成的完整文件前后状态。
    const changeSet: ChangeSet = {
      // 每次变更记录使用新的唯一 id。
      id: randomUUID(),
      // sessionId 表示这次变化属于哪条长期任务。
      sessionId: turn.sessionId,
      // turnId 表示变化由哪次用户请求产生。
      turnId: turn.id,
      // files 保存每个目标路径的 before 和 after 正文。
      files,
      // createdAt 使用当前 ISO 时间便于事件排序。
      createdAt: now(),
    }; // 完成 ChangeSet 构造。
    // 放入内存索引，UI 随后可以立即按 id 撤销。
    this.changeSets.set(changeSet.id, changeSet);
    // Ledger 记录新的 after 内容并增加代码 revision。
    this.options.getLedger(turn.sessionId)?.recordChanges(files.map((file) => ({ path: file.path, after: file.after })));
    // 修改后的文件使之前读取的证据哈希全部过期。
    this.options.getEvidence(turn.sessionId)?.invalidate(files.map((file) => file.path));
    // 在发布事件前落盘账本，保证 revision 与变更记录一致。
    await this.options.persistLedger(turn.sessionId);
    // 每个 before 正文写入独立 Snapshot，恢复不依赖当前磁盘内容。
    for (const file of files) await this.options.store.writeSnapshot(turn.sessionId, changeSet.id, file.path, file.before);
    // 同时发布事件和 changes Item，供 UI、回放器与模型历史恢复使用。
    await this.options.emit({ type: 'changes.created', timestamp: now(), changeSet }, { kind: 'changes', id: itemId(), changeSet, createdAt: now() });
  } // 结束变更记录方法。

  // finalizeTurn 在终态事件前把本轮全部 ChangeSet 聚合成唯一恢复点。
  async finalizeTurn(turn: Turn): Promise<Checkpoint | undefined> {
    // 已创建时直接返回，保证正常路径与异常清理路径重复调用也不会生成第二个恢复点。
    const existing = [...this.checkpoints.values()].find((checkpoint) => checkpoint.turnId === turn.id);
    // 命中已有结果时保持幂等。
    if (existing) return existing;
    // 查询本轮所有真实文件修改。
    const changeSets = this.changeSetsForTurn(turn.id);
    // 没有文件修改时不创建空恢复点，用户消息也不显示无意义的回退按钮。
    if (!changeSets.length) return undefined;
    // 聚合最早 before、最新 after 和全部 ChangeSet id。
    const checkpoint = this.buildCheckpoint(turn.sessionId, turn.id, changeSets);
    // 先登记内存索引，避免并发终态清理重复创建。
    this.checkpoints.set(checkpoint.id, checkpoint);
    // 只发布一次创建事件，历史与实时 UI 都只会看到一个逻辑恢复点。
    await this.options.emit({ type: 'checkpoint.created', timestamp: now(), turnId: turn.id, checkpoint });
    // 返回创建结果，便于测试或后续调用检查。
    return checkpoint;
  } // 结束 Turn 恢复点收口。

  // createCheckpoint 响应模型显式 checkpoint 工具，但不在 Turn 中途制造第二个恢复边界。
  async createCheckpoint(turn: Turn): Promise<ToolResult> {
    // 真正恢复点必须覆盖本轮后续可能发生的修改，所以只登记“终态时自动创建”的语义。
    return { ok: true, output: { scheduled: true, turnId: turn.id, message: '本轮结束时将统一创建一个恢复点' }, durationMs: 0 };
  } // 结束显式检查点创建方法。
} // 结束 ChangeManager 类。
