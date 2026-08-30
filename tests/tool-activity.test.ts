import { describe, expect, it } from 'vitest';
import { formatToolActivity } from '../apps/desktop/src/renderer/tool-activity';

const completed = (output: unknown, ok = true) => ({
  ok,
  output,
  durationMs: 12,
  ...(ok ? {} : { error: { code: 'read_failed', message: '文件不存在' } }),
});

describe('工具活动语义化展示', () => {
  it('读文件只展示路径和行号范围', () => {
    const view = formatToolActivity({
      name: 'read_file',
      args: { path: 'src/support.py', startLine: 12, endLine: 36 },
      result: completed({ path: 'src/support.py', startLine: 12, endLine: 36, text: '不应进入界面的文件正文' }),
    });

    expect(view.summary).toBe('已读取 src/support.py · 第 12–36 行');
    expect(view.details.map((detail) => detail.value)).toEqual(['src/support.py', '第 12–36 行']);
    expect(JSON.stringify(view)).not.toContain('不应进入界面的文件正文');
  });

  it('搜索结果只展示关键词、数量和命中位置', () => {
    const view = formatToolActivity({
      name: 'search_text',
      args: { query: 'handleSubmit' },
      result: completed([
        { path: 'src/App.tsx', line: 20, text: 'const handleSubmit = () => {' },
        { path: 'src/Form.tsx', line: 44, text: 'onSubmit={handleSubmit}' },
      ]),
    });

    expect(view.summary).toContain('2 处匹配');
    expect(view.details.map((detail) => detail.value)).toEqual(['src/App.tsx:20', 'src/Form.tsx:44']);
    expect(JSON.stringify(view)).not.toContain('onSubmit=');
  });

  it('命令卡片保留命令和退出码，不展开完整日志', () => {
    const view = formatToolActivity({
      name: 'run_command',
      args: { command: 'pnpm test', cwd: '.' },
      result: completed({ exitCode: 0, stdout: 'line one\n12 tests passed\n', stderr: '' }),
    });

    expect(view.summary).toBe('pnpm test · 退出码 0');
    expect(view.details).toContainEqual({ label: '最后输出', value: '12 tests passed' });
    expect(JSON.stringify(view)).not.toContain('line one');
  });

  it('计划卡片不展示步骤 id', () => {
    const view = formatToolActivity({
      name: 'set_plan',
      args: { steps: [{ id: 'internal-step-id', label: '定位问题', status: 'completed' }] },
      result: completed({}),
    });

    expect(view.details).toEqual([{ label: '已完成', value: '定位问题' }]);
    expect(JSON.stringify(view)).not.toContain('internal-step-id');
  });

  it('失败卡片只提供可行动的原因，不暴露错误代码', () => {
    const view = formatToolActivity({ name: 'read_file', args: { path: 'missing.ts' }, result: completed(undefined, false) });

    expect(view.summary).toContain('文件不存在');
    expect(JSON.stringify(view)).not.toContain('read_failed');
  });
});
