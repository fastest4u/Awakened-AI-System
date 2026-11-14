import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjectRoot } from '@/hooks/use-project-root';
import { mcpToolsQuery, invalidateProject } from '@/api/queries';
import { apiPost } from '@/api/client';
import {
  buildToolStarterJson,
  insertParamIntoArgs,
  toolSafety,
} from '@/lib/mcp-template';
import { ToolRunner } from './tool-runner';
import { ResponseOutput } from './response-output';
import type { McpCallResponse } from '@/api/types';

export function McpPage() {
  const projectRoot = useProjectRoot();
  const queryClient = useQueryClient();

  const { data: toolsData, isLoading } = useQuery(mcpToolsQuery());
  const tools = toolsData?.tools || [];

  const [selectedTool, setSelectedTool] = useState('memory_v2Status');
  const [rawArgs, setRawArgs] = useState('{}');
  const [output, setOutput] = useState(
    '// เลือก MCP Tool และกด Run เพื่อดูผลลัพธ์ JSON',
  );
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  // When tools load, if selectedTool not found in list, pick the first tool if available
  useEffect(() => {
    if (tools.length === 0) return;
    const exists = tools.some((t) => t.name === selectedTool);
    if (!exists) {
      const first = tools[0];
      setSelectedTool(first.name);
      setRawArgs(buildToolStarterJson(first));
    }
  }, [tools, selectedTool]);

  const handleSelectTool = (name: string) => {
    setSelectedTool(name);
    setIsConfirmOpen(false);
    const meta = tools.find((t) => t.name === name);
    setRawArgs(buildToolStarterJson(meta));
  };

  const handleResetTemplate = () => {
    const meta = tools.find((t) => t.name === selectedTool);
    setRawArgs(buildToolStarterJson(meta));
  };

  const handleInsertParam = (key: string) => {
    const meta = tools.find((t) => t.name === selectedTool);
    const prop = meta?.inputSchema?.properties?.[key];
    setRawArgs((prev) => insertParamIntoArgs(prev, key, prop));
  };

  const invokeMutation = useMutation({
    mutationFn: async (variables: {
      tool: string;
      args: Record<string, unknown>;
    }) => {
      return apiPost<McpCallResponse>('/api/mcp/call', {
        tool: variables.tool,
        args: variables.args,
        projectRoot,
      });
    },
    onSuccess: (data, variables) => {
      setOutput(JSON.stringify(data, null, 2));
      const meta = tools.find((t) => t.name === variables.tool);
      const safety = toolSafety(meta);
      if (safety !== 'read-only') {
        invalidateProject(queryClient, projectRoot);
      }
    },
    onError: (err: any) => {
      const errMsg = String(err?.message || err);
      setOutput(JSON.stringify({ ok: false, error: errMsg }, null, 2));
      toast.error(`รันคำสั่ง MCP ไม่สำเร็จ: ${errMsg}`);
    },
  });

  const handleExecute = (confirmed = false) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawArgs || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        toast.error('JSON Arguments ไม่ถูกต้อง');
        return;
      }
    } catch {
      toast.error('JSON Arguments ไม่ถูกต้อง');
      return;
    }

    const currentTool = tools.find((t) => t.name === selectedTool) ?? null;
    const safety = toolSafety(currentTool);

    if (safety === 'destructive' && !confirmed) {
      setIsConfirmOpen(true);
      return;
    }

    setIsConfirmOpen(false);
    invokeMutation.mutate({ tool: selectedTool, args: parsed });
  };

  if (isLoading && tools.length === 0) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
        <Skeleton className="h-[480px] rounded-xl" />
        <Skeleton className="h-[480px] rounded-xl" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
      <ToolRunner
        tools={tools}
        selectedTool={selectedTool}
        onSelectTool={handleSelectTool}
        rawArgs={rawArgs}
        onArgsChange={setRawArgs}
        onInsertParam={handleInsertParam}
        onResetTemplate={handleResetTemplate}
        onExecute={() => handleExecute(false)}
        isPending={invokeMutation.isPending}
        isConfirmOpen={isConfirmOpen}
        onConfirmOpenChange={setIsConfirmOpen}
        onConfirmExecute={() => handleExecute(true)}
        onCancelConfirm={() => setIsConfirmOpen(false)}
      />
      <ResponseOutput output={output} />
    </div>
  );
}
