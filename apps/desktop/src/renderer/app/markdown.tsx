import React from 'react';

export function InlineMarkdown({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={`${index}-${part}`}>{part.slice(1, -1)}</code>;
        }
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={`${index}-${part}`}>{part.slice(2, -2)}</strong>;
        }
        return <React.Fragment key={`${index}-${part}`}>{part}</React.Fragment>;
      })}
    </>
  );
}
export function MarkdownMessage({ text }: { text: string }): React.JSX.Element {
  const blocks = text.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return (
    <div className="markdown-message">
      {blocks.map((block, blockIndex) => {
        if (block.startsWith('```') && block.endsWith('```')) {
          const body = block.slice(3, -3).replace(/^[^\n]*\n/, '');
          return <pre key={`${blockIndex}-${block.slice(0, 12)}`}><code>{body}</code></pre>;
        }
        return block.split(/\r?\n/).map((line, lineIndex) => {
          const trimmed = line.trim();
          if (!trimmed) return <span className="markdown-gap" key={`${blockIndex}-${lineIndex}`} />;
          const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
          if (bullet) {
            return <div className="markdown-list-item" key={`${blockIndex}-${lineIndex}`}><span>•</span><div><InlineMarkdown text={bullet[1] ?? ''} /></div></div>;
          }
          return <div className="markdown-line" key={`${blockIndex}-${lineIndex}`}><InlineMarkdown text={line} /></div>;
        });
      })}
    </div>
  );
}
