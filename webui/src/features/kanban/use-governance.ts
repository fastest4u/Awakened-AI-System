import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost } from '@/api/client';
import { invalidateProject } from '@/api/queries';
import type { GovernanceAction } from '@/api/types';
import { toast } from 'sonner';

export interface GovernanceMutationVariables {
  action: GovernanceAction;
  recordId?: string;
  reason?: string;
  title?: string;
  summary?: string;
  content?: string;
  [key: string]: any;
}

export interface GovernanceResponse {
  ok: boolean;
  action: GovernanceAction;
  result: any;
}

export function useGovernance(projectRoot: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: GovernanceMutationVariables) => {
      const payload: Record<string, any> = {
        projectRoot,
        ...variables,
      };
      if (typeof payload.reason === 'string' && !payload.reason.trim()) {
        delete payload.reason;
      }
      return apiPost<GovernanceResponse>('/api/governance', payload);
    },
    onSuccess: async (_data, variables) => {
      await invalidateProject(queryClient, projectRoot);
      toast.success(`ดำเนินการ Governance (${variables.action}) สำเร็จ!`);
    },
    onError: (error: Error) => {
      toast.error(
        error.message || 'เกิดข้อผิดพลาดในการดำเนินการ Governance',
      );
    },
  });
}
