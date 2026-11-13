import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './theme-provider';
import { BootstrapContext } from '@/hooks/use-project-root';
import { ApiError } from '@/api/client';

interface AppProvidersProps {
  children: React.ReactNode;
  queryClient?: QueryClient;
  defaultProjectRoot?: string;
}

let globalQueryClient: QueryClient | null = null;

export function resetGlobalQueryClient(): void {
  globalQueryClient = null;
}

export function createDefaultQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (failureCount, error) => {
          if (
            error instanceof ApiError &&
            (error.status === 404 || error.status === 403)
          ) {
            return false;
          }
          return failureCount < 1;
        },
      },
    },
  });
}

export function getOrCreateQueryClient(): QueryClient {
  if (!globalQueryClient) {
    globalQueryClient = createDefaultQueryClient();
  }
  return globalQueryClient;
}

export function AppProviders({
  children,
  queryClient,
  defaultProjectRoot = '',
}: AppProvidersProps) {
  const qc = queryClient ?? getOrCreateQueryClient();

  return (
    <QueryClientProvider client={qc}>
      <BootstrapContext.Provider value={{ defaultProjectRoot }}>
        <ThemeProvider>{children}</ThemeProvider>
      </BootstrapContext.Provider>
    </QueryClientProvider>
  );
}
