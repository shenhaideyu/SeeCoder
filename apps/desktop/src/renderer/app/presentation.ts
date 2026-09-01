import type { ToolResult } from '@seecoder/protocol';

export const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
export const resultOutput = (value: unknown): unknown =>
  value && typeof value === 'object' && 'output' in value
    ? (value as { output?: unknown }).output
    : value;
export const formatCommandOutput = (value: unknown): string => {
  const output = resultOutput(value);
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const command = output as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    if (typeof command.stdout === 'string' || typeof command.stderr === 'string') {
      const body = [command.stdout, command.stderr].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
      return body || `退出码：${String(command.exitCode ?? '未知')}`;
    }
  }
  return JSON.stringify(output ?? '', null, 2);
};

export const toolPresentation: Record<string, { label: string; description: string }> = {
  list_files: { label: '浏览项目文件', description: '查看目录结构' },
  read_file: { label: '读取文件', description: '读取项目上下文' },
  read_files: { label: '批量读取文件', description: '收集相关代码上下文' },
  search_text: { label: '搜索代码', description: '定位相关实现' },
  write_file: { label: '写入文件', description: '更新工作区内容' },
  apply_patch: { label: '应用代码修改', description: '更新工作区内容' },
  run_command: { label: '运行命令', description: '执行验证或构建' },
  git_diff: { label: '检查代码变更', description: '读取 Git Diff' },
  set_plan: { label: '更新执行计划', description: '同步任务进度' },
  delegate: { label: '委派子 Agent', description: '并行收集只读证据' },
  review_changes: { label: '审查代码变更', description: '检查缺陷与测试缺口' },
  checkpoint: { label: '创建恢复点', description: '保存当前修改快照' },
  compact_context: { label: '整理上下文', description: '压缩较早的任务记录' },
  ask_user: { label: '请求用户确认', description: '等待补充信息' },
  finish: { label: '完成任务', description: '汇总变更与验证证据' },
};

export const isToolControlSignal = (result: ToolResult | undefined): boolean =>
  result?.error?.code === 'exploration_budget_exhausted';

export function friendlyAgentError(message: string): { title: string; summary: string } {
  if (/tool_call_id|deserialize|invalid_request_error/i.test(message)) {
    return {
      title: '模型接口格式不兼容',
      summary: '兼容接口拒绝了工具调用上下文。可重试任务；若仍失败，请检查模型与接口配置。',
    };
  }
  if (/401|unauthorized|api.?key/i.test(message)) {
    return { title: '模型鉴权失败', summary: '请在设置中检查 API Key，然后重新尝试。' };
  }
  if (/429|rate.?limit/i.test(message)) {
    return { title: '请求过于频繁', summary: '模型服务暂时限流，请稍后重新尝试。' };
  }
  if (/timeout|timed out/i.test(message)) {
    return { title: '执行超时', summary: '模型或工具未在限制时间内完成，可缩小任务范围后重试。' };
  }
  return {
    title: '任务未完成',
    summary: message.length > 180 ? `${message.slice(0, 177)}…` : message,
  };
}
