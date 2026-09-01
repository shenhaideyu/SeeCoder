// relative 用于判断目标是否跳出工作区，resolve 用于把相对路径转为绝对路径。
import { relative, resolve } from 'node:path';

// 星号代表“整个 Workspace”，会与任何具体文件锁发生冲突。
const WORKSPACE_LOCK = '*';

// LockRequest 描述一个尚未获准执行的写入请求。
interface LockRequest {
  // keys 是本次操作希望独占的规范化文件路径集合。
  keys: Set<string>;
  // grant 在调度器确认无冲突后唤醒等待中的 Promise。
  grant: () => void;
} // 结束锁请求接口。

// WorkspaceLockState 保存同一 Workspace 当前占用和排队情况。
interface WorkspaceLockState {
  // active 中每个 Set 都代表一项正在执行的副作用操作。
  active: Set<Set<string>>;
  // pending 按到达顺序保存尚未获锁的请求。
  pending: LockRequest[];
} // 结束工作区锁状态接口。

// 模块级 Map 让同一进程里的多个 AgentCore 实例共享 Workspace 写入锁。
const states = new Map<string, WorkspaceLockState>();

// platformKey 把路径转换为可稳定比较的锁键。
function platformKey(value: string): string {
  // resolve 消除相对段和多余分隔符，得到规范绝对路径。
  const normalized = resolve(value);
  // Windows 路径不区分大小写，所以统一转小写；其他平台保留大小写。
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
} // 结束路径键规范化函数。

// conflicts 判断两组锁是否保护了相同写入范围。
function conflicts(left: Set<string>, right: Set<string>): boolean {
  // 任一方持有全工作区锁时，任何其他副作用操作都必须等待。
  if (left.has(WORKSPACE_LOCK) || right.has(WORKSPACE_LOCK)) return true;
  // 逐个检查左侧路径是否也出现在右侧集合中。
  for (const key of left) if (right.has(key)) return true;
  // 没有共同路径表示两个操作可以安全并行。
  return false;
} // 结束锁冲突判断函数。

// WorkspaceMutationCoordinator 协调同一 Workspace 的副作用操作，防止不同 Session 互相覆盖文件。
export class WorkspaceMutationCoordinator {
  // workspaceKey 是当前 Workspace 在模块级 states Map 中的索引。
  private readonly workspaceKey: string;
  // state 是该 Workspace 被所有 AgentCore 实例共享的锁状态对象。
  private readonly state: WorkspaceLockState;

  // 构造函数绑定当前实例所服务的 Workspace。
  constructor(private readonly workspace: string) {
    // 规范化 Workspace 路径，Windows 上不同大小写会映射到同一把锁。
    this.workspaceKey = platformKey(workspace);
    // 已有状态时复用；第一次遇到此 Workspace 时创建空状态。
    this.state = states.get(this.workspaceKey) ?? { active: new Set(), pending: [] };
    // 写回 Map，确保后续实例能取得同一个 state 引用。
    states.set(this.workspaceKey, this.state);
  } // 结束协调器构造过程。

  // runExclusive 在获得指定文件的独占锁后执行 action，并保证最后释放锁。
  async runExclusive<T>(paths: string[], action: () => Promise<T>): Promise<T> {
    // 把调用方提供的相对路径转换成排序后的规范锁键。
    const keys = this.normalizePaths(paths);
    // 等待调度器确认当前路径与活动操作不存在冲突。
    await this.acquire(keys);
    // try/finally 保证 action 成功、失败或抛错时都会释放锁。
    try {
      // 返回 action 的真实结果，让协调器不改变上层业务返回值。
      return await action();
    // finally 在 return 或异常传播前执行资源清理。
    } finally {
      // 删除这组活动锁并尝试唤醒后续排队请求。
      this.release(keys);
    } // 结束独占执行和清理。
  } // 结束文件级独占执行方法。

  // runWorkspaceExclusive 为无法预先确定写入文件的操作锁住整个 Workspace。
  runWorkspaceExclusive<T>(action: () => Promise<T>): Promise<T> {
    // 空路径会在 normalizePaths 中升级为星号全局锁。
    return this.runExclusive([], action);
  } // 结束工作区级独占执行方法。

  // normalizePaths 校验路径边界并生成不会因顺序不同而变化的 Set。
  private normalizePaths(paths: string[]): Set<string> {
    // 空数组表示写入范围未知，必须与所有其他写入互斥。
    if (paths.length === 0) return new Set([WORKSPACE_LOCK]);
    // keys 收集去重后的规范绝对路径。
    const keys = new Set<string>();
    // 逐个校验调用方声明的写入目标。
    for (const path of paths) {
      // resolve 把相对目标固定在当前 Workspace 下。
      const target = resolve(this.workspace, path);
      // relative 计算从 Workspace 到目标的相对关系，用于发现向上逃逸。
      const inside = relative(this.workspace, target);
      // 以 .. 开头表示越界；目标等于根目录也不允许作为具体文件锁。
      if (inside.startsWith('..') || resolve(target) === resolve(this.workspace)) {
        // 抛错会在任何锁入队前终止，避免非法路径影响调度状态。
        throw new Error(`写入锁路径越出 workspace：${path}`);
      } // 结束单条路径边界检查。
      // 使用平台键加入 Set，同一路径重复出现只保留一次。
      keys.add(platformKey(target));
    } // 结束路径规范化循环。
    // 排序后重新创建 Set，使多文件操作始终使用一致顺序，便于调试和测试。
    return new Set([...keys].sort());
  } // 结束路径规范化方法。

  // acquire 把请求加入等待队列，并在获准时解析 Promise。
  private acquire(keys: Set<string>): Promise<void> {
    // Promise 会一直 pending，直到 drain 调用传入的 grant。
    return new Promise((grant) => {
      // push 保持请求到达顺序，为冲突请求提供公平性。
      this.state.pending.push({ keys, grant });
      // 新请求入队后立即尝试调度它和前面可并行的请求。
      this.drain();
    }); // 返回代表“已经获锁”的等待 Promise。
  } // 结束获锁方法。

  // release 释放一组活动锁并重新运行队列调度。
  private release(keys: Set<string>): void {
    // active 保存的是同一个 Set 对象引用，因此可以精确删除。
    this.state.active.delete(keys);
    // 锁释放后，之前有冲突的请求可能已经可以执行。
    this.drain();
  } // 结束释放方法。

  // drain 从前向后扫描等待队列，启动当前能够安全并行的请求。
  private drain(): void {
    // 手动维护 index，因为批准请求后会从 pending 中删除当前元素。
    for (let index = 0; index < this.state.pending.length;) {
      // 非空断言成立，因为循环条件保证 index 位于数组范围内。
      const request = this.state.pending[index]!;
      // activeConflict 检查它是否与任何正在执行的操作重叠。
      const activeConflict = [...this.state.active].some((keys) => conflicts(keys, request.keys));
      // earlierConflict 防止后到请求越过更早的冲突请求，避免早期请求长期饥饿。
      const earlierConflict = this.state.pending.slice(0, index).some((pending) => conflicts(pending.keys, request.keys));
      // 与活动操作或更早请求冲突时保留在队列，继续检查后面的独立路径。
      if (activeConflict || earlierConflict) {
        // 当前请求仍在数组中，因此索引移动到下一项。
        index += 1;
        // continue 跳过下面的批准逻辑。
        continue;
      } // 结束冲突请求处理。
      // 无冲突时从等待队列移除；后面的元素会自动左移到当前 index。
      this.state.pending.splice(index, 1);
      // 把锁集合加入 active，阻止后续冲突操作同时启动。
      this.state.active.add(request.keys);
      // 解析 acquire 返回的 Promise，让真实 action 开始运行。
      request.grant();
    } // 所有当前可启动请求处理完成后退出循环。
  } // 结束队列调度方法。
} // 结束 WorkspaceMutationCoordinator 类。
