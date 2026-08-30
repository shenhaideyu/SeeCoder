import type { ContextCompactionMetrics, ToolResult } from '@seecoder/protocol';

export interface ToolActivityDetail {
  label?: string;
  value: string;
  kind?: 'text' | 'path' | 'code' | 'error';
}

export interface ToolActivityView {
  title: string;
  summary: string;
  details: ToolActivityDetail[];
}

export interface ToolActivityInput {
  name?: string | undefined;
  args?: unknown;
  result?: ToolResult | undefined;
  contextMetrics?: ContextCompactionMetrics | undefined;
  checkpointFiles?: string[] | undefined;
}

const labels: Record<string, string> = {
  list_files: '浏览项目文件',
  read_file: '读取文件',
  read_files: '批量读取文件',
  search_text: '搜索代码',
  write_file: '写入文件',
  apply_patch: '应用代码修改',
  run_command: '运行命令',
  git_diff: '检查代码变更',
  set_plan: '更新执行计划',
  delegate: '委派只读子 Agent',
  review_changes: '审查代码变更',
  checkpoint: '创建恢复点',
  compact_context: '整理上下文',
  ask_user: '请求用户确认',
  finish: '完成任务',
};

const statusLabels: Record<string, string> = {
  pending: '待处理',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
};

function labelFor(name?: string): string {
  return labels[name ?? ''] ?? '执行工具';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shorten(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function outputRecord(result: ToolResult | undefined): Record<string, unknown> {
  return asRecord(result?.output);
}

function changedPaths(result: ToolResult | undefined): string[] {
  return asArray(outputRecord(result).files)
    .map((entry) => text(asRecord(entry).path))
    .filter((value): value is string => Boolean(value));
}

function pathsFromPatch(patch: string | undefined): string[] {
  if (!patch) return [];
  const paths = [
    ...[...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)].map((match) => match[1]),
    ...[...patch.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)].map((match) => match[1]),
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value) && value !== '/dev/null');
  return [...new Set(paths)];
}

function fileDetails(paths: string[], limit = 12): ToolActivityDetail[] {
  const visible: ToolActivityDetail[] = paths.slice(0, limit).map((path) => ({ value: path, kind: 'path' }));
  if (paths.length > limit) visible.push({ value: `还有 ${paths.length - limit} 个文件`, kind: 'text' });
  return visible;
}

function rangeLabel(start: number | undefined, end: number | undefined): string | undefined {
  if (start === undefined && end === undefined) return undefined;
  if (start !== undefined && end !== undefined) return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
  return start !== undefined ? `从第 ${start} 行开始` : `到第 ${end} 行`;
}

function errorView(input: ToolActivityInput): ToolActivityView | undefined {
  if (!input.result || input.result.ok) return undefined;
  const title = labelFor(input.name);
  const message = input.result.error?.message ?? '工具未能完成操作';
  return {
    title,
    summary: `失败 · ${shorten(message, 140)}`,
    details: [{ label: '原因', value: message, kind: 'error' }],
  };
}

export function formatToolActivity(input: ToolActivityInput): ToolActivityView {
  const failed = errorView(input);
  if (failed) return failed;

  const name = input.name;
  const args = asRecord(input.args);
  const output = outputRecord(input.result);
  const finished = Boolean(input.result);
  const verb = finished ? '已' : '正在';

  if (!name && input.contextMetrics) {
    const metrics = input.contextMetrics;
    const source = metrics.summarySource === 'model' ? '模型摘要' : '确定性摘要';
    return {
      title: '整理上下文',
      summary: `已将估算输入从 ${metrics.beforeTokens} 降至 ${metrics.afterTokens} tokens`,
      details: [
        { label: '摘要方式', value: source },
        { label: '历史召回', value: `${metrics.retrievedEntries} 条` },
        { label: '过期证据', value: `${metrics.droppedEvidence} 条已移出当前上下文` },
      ],
    };
  }

  if (!name && input.checkpointFiles) {
    return {
      title: '已创建恢复点',
      summary: input.checkpointFiles.length ? `可恢复 ${input.checkpointFiles.length} 个文件` : '当前状态可恢复',
      details: fileDetails(input.checkpointFiles),
    };
  }

  if (name === 'list_files') {
    const path = text(args.path) ?? '工作区根目录';
    const files = asArray(input.result?.output).filter((value): value is string => typeof value === 'string');
    return { title: labelFor(name), summary: finished ? `已浏览 ${path} · ${files.length} 项` : `正在浏览 ${path}`, details: fileDetails(files) };
  }

  if (name === 'read_file') {
    const path = text(output.path) ?? text(args.path) ?? '未知文件';
    const range = rangeLabel(numberValue(output.startLine) ?? numberValue(args.startLine), numberValue(output.endLine) ?? numberValue(args.endLine));
    return {
      title: labelFor(name),
      summary: `${verb}读取 ${path}${range ? ` · ${range}` : ''}`,
      details: [{ label: '文件', value: path, kind: 'path' }, ...(range ? [{ label: '范围', value: range } satisfies ToolActivityDetail] : [])],
    };
  }

  if (name === 'read_files') {
    const outputs = asArray(input.result?.output).map(asRecord);
    const requested = asArray(args.paths).filter((value): value is string => typeof value === 'string');
    const paths = outputs.length ? outputs.map((entry) => text(entry.path)).filter((value): value is string => Boolean(value)) : requested;
    const failedCount = outputs.filter((entry) => text(entry.error)).length;
    const suffix = failedCount ? ` · ${failedCount} 个失败` : '';
    return { title: labelFor(name), summary: `${verb}读取 ${paths.length} 个文件${suffix}`, details: fileDetails(paths) };
  }

  if (name === 'search_text') {
    const query = text(args.query) ?? '未知关键词';
    const matches = asArray(input.result?.output).map(asRecord);
    const locations = matches.map((match) => {
      const path = text(match.path);
      const line = numberValue(match.line);
      return path ? `${path}${line ? `:${line}` : ''}` : undefined;
    }).filter((value): value is string => Boolean(value));
    return {
      title: labelFor(name),
      summary: finished ? `已搜索“${shorten(query, 70)}” · ${matches.length} 处匹配` : `正在搜索“${shorten(query, 70)}”`,
      details: fileDetails([...new Set(locations)]),
    };
  }

  if (name === 'write_file' || name === 'apply_patch') {
    const paths = changedPaths(input.result);
    const fallback = name === 'write_file' ? [text(args.path)].filter((value): value is string => Boolean(value)) : pathsFromPatch(text(args.patch));
    const files = paths.length ? paths : fallback;
    const action = name === 'write_file' ? '写入' : '修改';
    return {
      title: labelFor(name),
      summary: files.length === 1 ? `${verb}${action} ${files[0]}` : `${verb}${action} ${files.length} 个文件`,
      details: fileDetails(files),
    };
  }

  if (name === 'run_command') {
    const command = text(args.command) ?? '未知命令';
    const exitCode = numberValue(output.exitCode);
    const status = finished ? (exitCode === undefined ? '已结束' : `退出码 ${exitCode}`) : '执行中';
    const diagnostic = text(output.stderr)?.split(/\r?\n/).filter(Boolean).at(-1) ?? text(output.stdout)?.split(/\r?\n/).filter(Boolean).at(-1);
    return {
      title: labelFor(name),
      summary: `${shorten(command, 120)} · ${status}`,
      details: [
        { label: '命令', value: command, kind: 'code' },
        ...(text(args.cwd) ? [{ label: '目录', value: text(args.cwd)!, kind: 'path' as const }] : []),
        ...(diagnostic ? [{ label: '最后输出', value: shorten(diagnostic, 300) }] : []),
        { value: '完整 stdout/stderr 可在右侧“终端”查看。' },
      ],
    };
  }

  if (name === 'git_diff') {
    const path = text(args.path);
    return {
      title: labelFor(name),
      summary: `${verb}检查${path ? ` ${path} 的` : '工作区'}变更`,
      details: [{ value: '完整差异可在右侧“变更”查看。' }],
    };
  }

  if (name === 'set_plan') {
    const steps = asArray(args.steps).map(asRecord);
    return {
      title: labelFor(name),
      summary: `${verb}更新 ${steps.length} 个计划步骤`,
      details: steps.map((step) => ({ label: statusLabels[text(step.status) ?? ''] ?? '计划', value: text(step.label) ?? '未命名步骤' })),
    };
  }

  if (name === 'delegate') {
    const role = text(args.role) === 'review' ? '审查' : '探索';
    const task = text(args.task) ?? '收集项目证据';
    const summary = text(output.summary);
    return { title: labelFor(name), summary: `${role} Agent · ${shorten(task, 120)}`, details: summary ? [{ label: '结论', value: shorten(summary, 500) }] : [] };
  }

  if (name === 'review_changes') {
    const scope = text(args.scope) ?? '最近一轮变更';
    const findings = asArray(output.findings);
    return { title: labelFor(name), summary: finished ? `已审查 ${scope} · ${findings.length} 项发现` : `正在审查 ${scope}`, details: [{ label: '范围', value: scope }] };
  }

  if (name === 'checkpoint') {
    const files = asArray(output.files).map((entry) => text(asRecord(entry).path)).filter((value): value is string => Boolean(value));
    return { title: labelFor(name), summary: finished ? '已创建恢复点' : '正在创建恢复点', details: fileDetails(files) };
  }

  if (name === 'compact_context') {
    return { title: labelFor(name), summary: finished ? '已请求整理较早的任务记录' : '正在整理较早的任务记录', details: [] };
  }

  if (name === 'ask_user') {
    const question = text(args.question) ?? '需要补充信息';
    const answer = text(output.answer);
    return { title: labelFor(name), summary: answer ? '已收到用户回复' : '等待用户回复', details: [{ label: '问题', value: question }, ...(answer ? [{ label: '回复', value: answer }] : [])] };
  }

  if (name === 'finish') {
    const summary = text(output.summary) ?? text(args.summary) ?? '任务已完成';
    const warning = text(output.warning);
    return {
      title: warning ? '完成，但缺少最新验证' : labelFor(name),
      summary: warning ? shorten(warning, 160) : shorten(summary, 160),
      details: [{ label: '结果', value: summary }, ...(warning ? [{ label: '验证', value: warning, kind: 'error' as const }] : [])],
    };
  }

  return {
    title: labels[name ?? ''] ?? '执行工具',
    summary: finished ? '操作已完成' : '操作执行中',
    details: [],
  };
}
