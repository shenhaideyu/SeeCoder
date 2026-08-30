import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { DiffEditor } from '@monaco-editor/react';
import { ChevronDown, ChevronRight, Code2, Maximize2, X } from 'lucide-react';

export type PatchLineKind = 'add' | 'remove' | 'context' | 'meta';

export interface PatchPreviewLine {
  kind: PatchLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface PatchPreviewFile {
  path: string;
  lines: PatchPreviewLine[];
}

const patchFileHeader = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/;
const unifiedFileHeader = /^\+\+\+ (?:b\/)?(.+)$/;
const hunkHeader = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/** 把补丁协议转换为只含用户需要信息的逐文件 Diff。 */
export function parsePatchPreview(patch: string): PatchPreviewFile[] {
  const files: PatchPreviewFile[] = [];
  let current: PatchPreviewFile | undefined;
  let oldLine: number | undefined;
  let newLine: number | undefined;

  const ensureFile = (path = '工作区修改'): PatchPreviewFile => {
    if (!current) {
      current = { path, lines: [] };
      files.push(current);
    }
    return current;
  };

  for (const rawLine of patch.replace(/\r\n/g, '\n').split('\n')) {
    const fileMatch = patchFileHeader.exec(rawLine) ?? unifiedFileHeader.exec(rawLine);
    if (fileMatch) {
      const path = fileMatch[1]!.trim();
      if (path !== '/dev/null' && current?.path !== path) {
        current = { path, lines: [] };
        files.push(current);
      }
      continue;
    }
    if (/^(?:\*\*\* Begin Patch|\*\*\* End Patch|--- (?:a\/)?)/.test(rawLine)) continue;

    const hunk = hunkHeader.exec(rawLine);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      ensureFile().lines.push({ kind: 'meta', text: rawLine });
      continue;
    }
    if (rawLine === '@@') {
      oldLine = undefined;
      newLine = undefined;
      ensureFile().lines.push({ kind: 'meta', text: '变更片段' });
      continue;
    }
    if (rawLine.startsWith('+')) {
      ensureFile().lines.push({ kind: 'add', text: rawLine.slice(1), ...(newLine === undefined ? {} : { newLine }) });
      if (newLine !== undefined) newLine += 1;
      continue;
    }
    if (rawLine.startsWith('-')) {
      ensureFile().lines.push({ kind: 'remove', text: rawLine.slice(1), ...(oldLine === undefined ? {} : { oldLine }) });
      if (oldLine !== undefined) oldLine += 1;
      continue;
    }
    if (rawLine.startsWith(' ')) {
      ensureFile().lines.push({
        kind: 'context',
        text: rawLine.slice(1),
        ...(oldLine === undefined ? {} : { oldLine }),
        ...(newLine === undefined ? {} : { newLine }),
      });
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
      continue;
    }
    if (rawLine.trim()) ensureFile().lines.push({ kind: 'meta', text: rawLine });
  }

  return files.filter((file) => file.lines.length > 0);
}

function useEscape(onClose: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, onClose]);
}

function PatchLines({ file }: { file: PatchPreviewFile }): React.JSX.Element {
  return (
    <div className="patch-diff-scroll" role="region" aria-label={`${file.path} 代码差异`} tabIndex={0}>
      <div className="patch-diff-code">
        {file.lines.map((line, index) => (
          <div className={`patch-diff-line ${line.kind}`} key={`${index}-${line.kind}`}>
            <span className="patch-line-number">{line.oldLine ?? ''}</span>
            <span className="patch-line-number">{line.newLine ?? ''}</span>
            <span className="patch-line-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : line.kind === 'meta' ? '··' : ' '}</span>
            <code>{line.text || ' '}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  useEscape(onClose, true);
  return createPortal(
    <div className="diff-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="diff-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <Code2 size={16} />
          <strong title={title}>{title}</strong>
          <span>按 Esc 关闭</span>
          <button className="icon-button" data-action="close-diff-dialog" aria-label="关闭代码差异" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="diff-dialog-content">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function PatchDiffPreview({ patch }: { patch: string }): React.JSX.Element | null {
  const files = useMemo(() => parsePatchPreview(patch), [patch]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const file = files[Math.min(selected, Math.max(0, files.length - 1))];
  if (!file) return null;

  const content = (
    <>
      {files.length > 1 && (
        <div className="patch-file-tabs" role="tablist" aria-label="补丁文件">
          {files.map((item, index) => (
            <button key={item.path} className={selected === index ? 'active' : ''} role="tab" aria-selected={selected === index} onClick={() => setSelected(index)} title={item.path}>{item.path}</button>
          ))}
        </div>
      )}
      <PatchLines file={file} />
    </>
  );

  return (
    <div className={`approval-diff ${open ? 'open' : ''}`}>
      <div className="approval-diff-toolbar">
        <button data-action="toggle-patch-diff" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Code2 size={14} />
          <span title={file.path}>{files.length > 1 ? `${files.length} 个文件` : file.path}</span>
        </button>
        {open && <button className="diff-expand-button" data-action="expand-patch-diff" onClick={() => setDialogOpen(true)}><Maximize2 size={13} />扩大查看</button>}
      </div>
      {open && <div className="approval-diff-body">{content}</div>}
      {dialogOpen && <DiffDialog title={file.path} onClose={() => setDialogOpen(false)}>{content}</DiffDialog>}
    </div>
  );
}

const diffOptions = {
  readOnly: true,
  minimap: { enabled: false },
  renderSideBySide: false,
  lineNumbers: 'on' as const,
  wordWrap: 'off' as const,
  diffWordWrap: 'off' as const,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  padding: { top: 8, bottom: 8 },
  scrollbar: { vertical: 'auto' as const, horizontal: 'visible' as const, horizontalScrollbarSize: 10 },
};

export function ChangeDiffViewer({ id, path, language, before, after }: { id: string; path: string; language: string; before: string; after: string }): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const editor = (height: string, suffix: string) => (
    <DiffEditor
      height={height}
      language={language}
      theme="vs-dark"
      original={before}
      modified={after}
      originalModelPath={`inmemory://seecoder/${id}/${suffix}/before/${encodeURIComponent(path)}`}
      modifiedModelPath={`inmemory://seecoder/${id}/${suffix}/after/${encodeURIComponent(path)}`}
      options={diffOptions}
    />
  );
  return (
    <>
      <button className="diff-expand-button" data-action="expand-change-diff" onClick={() => setDialogOpen(true)}><Maximize2 size={13} />展开</button>
      <div className="change-diff-inline">{editor('240px', 'inline')}</div>
      {dialogOpen && <DiffDialog title={path} onClose={() => setDialogOpen(false)}>{editor('calc(100vh - 112px)', 'dialog')}</DiffDialog>}
    </>
  );
}
