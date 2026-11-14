import { createContext, useContext } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { projectsQuery } from '@/api/queries';

export interface BootstrapContextValue {
  defaultProjectRoot: string;
}

export const BootstrapContext = createContext<BootstrapContextValue>({
  defaultProjectRoot: '',
});

export function useProjectRoot(): string {
  let searchProject: string | undefined;
  try {
    const search = useSearch({ strict: false }) as any;
    searchProject = search?.project;
  } catch {
    // outside of router context
  }

  const bootstrap = useContext(BootstrapContext);
  const { data: projectsData } = useQuery({
    ...projectsQuery(),
    enabled: !searchProject && !bootstrap.defaultProjectRoot,
  });

  return (
    searchProject ||
    bootstrap.defaultProjectRoot ||
    projectsData?.defaultProjectRoot ||
    (typeof document !== 'undefined'
      ? document
          .querySelector('meta[name="pm-default-project"]')
          ?.getAttribute('content') || ''
      : '')
  );
}
