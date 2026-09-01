import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export interface PromptRequest {
  title: string;
  value?: string;
  description?: string;
  placeholder?: string;
  confirm?: boolean;
  cancelLabel?: string;
  submitLabel?: string;
}

export function PromptDialog({
  request,
  onResolve,
}: {
  request: PromptRequest | undefined;
  onResolve: (value: string | null) => void;
}): React.JSX.Element | null {
  const [value, setValue] = useState(request?.value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setValue(request?.value ?? '');
    if (request) window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [request]);
  if (!request) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onResolve(null); }}>
      <div className="prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-dialog-title">
        <div className="prompt-dialog-head">
          <strong id="prompt-dialog-title">{request.title}</strong>
          <button className="icon-button" data-action="dialog-close" title="关闭" aria-label="关闭" onClick={() => onResolve(null)}><X size={15} /></button>
        </div>
        {request.description && <p>{request.description}</p>}
        {!request.confirm && (
          <input
            ref={inputRef}
            autoFocus
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); onResolve(value); }
              if (event.key === 'Escape') { event.preventDefault(); onResolve(null); }
            }}
          />
        )}
        <div className="prompt-dialog-actions">
          <button className="small-button" data-action="dialog-cancel" onClick={() => onResolve(null)}>{request.cancelLabel ?? '取消'}</button>
          <button className="small-button primary" data-action="dialog-submit" onClick={() => onResolve(request.confirm ? '__confirm__' : value)}>
            {request.submitLabel ?? (request.confirm ? '确认' : '确定')}
          </button>
        </div>
      </div>
    </div>
  );
}
