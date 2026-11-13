import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './theme-provider';
import { BootstrapContext } from '@/hooks/use-project-root';

interface AppProvidersProps {
  children: React.ReactNode;
  queryClient?: QueryClient;
  defaultProjectRoot?: string;
}

let globalQueryClient: QueryClient | null = null;

export function getOrCreateQueryClient(): QueryClient {
  if (!globalQueryClient) {
    globalQueryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 15_000,
          retry: 1,
        },
      },
    });
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
