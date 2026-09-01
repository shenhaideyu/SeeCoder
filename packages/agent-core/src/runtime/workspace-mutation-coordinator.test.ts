// mkdtemp 创建隔离的临时工作区，rm 在用例结束后递归清理它。
import { mkdtemp, rm } from 'node:fs/promises';
// tmpdir 返回操作系统允许写入临时文件的根目录。
import { tmpdir } from 'node:os';
// join 以当前平台正确的分隔符拼接临时目录名称。
import { join } from 'node:path';
// Vitest 提供测试分组、断言和异步测试函数。
import { describe, expect, it } from 'vitest';
// 导入本文件要验证的工作区写入协调器。
import { WorkspaceMutationCoordinator } from './workspace-mutation-coordinator';

// 测试路径级锁与工作区级锁的并发行为。
describe('WorkspaceMutationCoordinator', () => {
  // 同一路径必须串行，不同路径即使来自另一个协调器实例也应允许并行。
  it('serializes the same file across coordinators but allows different files', async () => {
    // 每个用例使用唯一临时目录，避免全局锁 key 与其他测试冲突。
    const workspace = await mkdtemp(join(tmpdir(), 'seecoder-lock-'));
    // 进入可能失败的操作区，异常会交给后面的 catch 或 finally 处理。
    try {
      // 两个实例模拟两个 Session 同时修改同一个真实工作区。
      const first = new WorkspaceMutationCoordinator(workspace);
      // 第二个实例必须仍能看到第一个实例持有的共享锁。
      const second = new WorkspaceMutationCoordinator(workspace);
      // order 记录每段异步动作真正发生的先后顺序。
      const order: string[] = [];
      // release 稍后手动放行第一个写操作；非空断言表示 Promise 构造时一定赋值。
      let release!: () => void;
      // gate 是一个人为暂停点，resolve 前第一个写操作不会结束。
      const gate = new Promise<void>((resolve) => {
        // 保存 Promise 的 resolve，测试后半段用它打开闸门。
        release = resolve;
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      });
      // first 获得 same.ts 的锁并开始一个暂不结束的写操作。
      const writing = first.runExclusive(['same.ts'], async () => {
        // 标记第一个写操作已经获得锁并进入回调。
        order.push('first-start');
        // 等待测试代码调用 release()。
        await gate;
        // 闸门放行后记录第一个写操作即将释放锁。
        order.push('first-end');
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      });
      // 让当前微任务队列运行一次，确保 writing 已进入回调并持有锁。
      await Promise.resolve();
      // 同一路径的第二次写入应排队，暂时不能把 second 写入 order。
      const waiting = second.runExclusive(['same.ts'], async () => {
        // 只有 first 释放 same.ts 后才会执行此行。
        order.push('second');
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      });
      // other.ts 与 same.ts 不冲突，应当可以立刻并行执行。
      const parallel = second.runExclusive(['other.ts'], async () => {
        // 记录不同文件操作成功穿过锁。
        order.push('other');
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      });
      // 等待不同文件操作完成，固定第一次检查的时间点。
      await parallel;
      // 此时 first 已开始、other 已完成，而 second 仍必须等待。
      expect(order).toEqual(['first-start', 'other']);
      // 打开 gate，让 first 完成并释放 same.ts。
      release();
      // 等待第一个写入和排队中的第二个写入全部结束。
      await Promise.all([writing, waiting]);
      // 最终顺序证明同文件串行、不同文件并行。
      expect(order).toEqual(['first-start', 'other', 'first-end', 'second']);
    // 无论成功、失败或取消都执行清理，防止临时状态和资源泄漏。
    } finally {
      // 无论断言成功还是抛错，都删除本用例创建的临时目录。
      await rm(workspace, { recursive: true, force: true });
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
  }); // 结束跨实例路径锁测试。

  // 验证受保护动作抛异常时，finally 仍会释放工作区独占锁。
  it('releases a workspace lock when the action throws', async () => {
    // 创建与上一用例隔离的新临时工作区。
    const workspace = await mkdtemp(join(tmpdir(), 'seecoder-lock-error-'));
    // 进入可能失败的操作区，异常会交给后面的 catch 或 finally 处理。
    try {
      // 创建负责该工作区锁管理的协调器。
      const coordinator = new WorkspaceMutationCoordinator(workspace);
      // 独占动作主动抛出 boom；rejects 断言该错误会传给调用方。
      await expect(
        // 执行 workspace-mutation-coordinator.test.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        coordinator.runWorkspaceExclusive(async () => {
          // 模拟真实命令或文件写入过程中发生异常。
          throw new Error('boom');
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }),
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      ).rejects.toThrow('boom');
      // 如果上一行已经释放全局锁，后续路径写入就能正常返回 ok。
      await expect(coordinator.runExclusive(['next.ts'], async () => 'ok')).resolves.toBe('ok');
    // 无论成功、失败或取消都执行清理，防止临时状态和资源泄漏。
    } finally {
      // 强制清理临时目录，即使目录内容已不存在也不报错。
      await rm(workspace, { recursive: true, force: true });
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
  }); // 结束异常释放锁测试。
}); // 结束 WorkspaceMutationCoordinator 测试组。
