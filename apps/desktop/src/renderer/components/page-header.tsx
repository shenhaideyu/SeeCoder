import React from 'react';
import type { LucideIcon } from 'lucide-react';

export function PageHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
}): React.JSX.Element {
  return (
    <header className="page-header">
      <div className="page-icon">
        <Icon size={20} />
      </div>
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </header>
  );
}
