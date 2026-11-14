import React from 'react';
import { Folder } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { projectsQuery } from '@/api/queries';
import { useProjectRoot } from '@/hooks/use-project-root';
import type { AppSearch } from '@/lib/search';
import { cn } from '@/lib/utils';

export function ProjectSwitcher({ className }: { className?: string }) {
  const navigate = useNavigate();
  const currentProject = useProjectRoot();
  const { data } = useQuery(projectsQuery());
  const projects = data?.projects ?? [];

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextProject = e.target.value;
    navigate({
      to: '.',
      search: (prev: AppSearch) => ({
        ...prev,
        project: nextProject,
      }),
      replace: false,
    });
  };

  return (
    <div className={cn('flex items-center gap-1.5 text-xs', className)}>
      <Folder className="size-4 shrink-0 text-muted-foreground" />
      <label
        htmlFor="project-switcher-select"
        className="font-medium text-muted-foreground shrink-0"
      >
        โปรเจกต์:
      </label>
      <select
        id="project-switcher-select"
        aria-label="โปรเจกต์"
        value={currentProject}
        onChange={handleChange}
        className="h-8 rounded-md border border-input bg-card px-2.5 py-1 text-xs text-foreground shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
      >
        {projects.length === 0 ? (
          <option value={currentProject}>
            {currentProject || 'เลือกโปรเจกต์...'}
          </option>
        ) : (
          projects.map((p) => (
            <option key={p.projectRoot} value={p.projectRoot}>
              {p.name} ({p.mode})
            </option>
          ))
        )}
      </select>
    </div>
  );
}
