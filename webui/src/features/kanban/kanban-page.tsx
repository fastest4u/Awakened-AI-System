import { useState, useEffect, useMemo } from 'react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { notesQuery } from '@/api/queries';
import { useProjectRoot } from '@/hooks/use-project-root';
import { useOpenNote } from '@/hooks/use-open-note';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { columnForStatus } from '@/lib/kanban';
import { Skeleton } from '@/components/ui/skeleton';
import { QuickEntry, type QuickEntryKind } from './quick-entry';
import { KanbanToolbar } from './kanban-toolbar';
import { KanbanBoard } from './kanban-board';
import { NotesTable } from './notes-table';
import {
  GovernanceConfirmDialog,
  type GovernanceConfirmAction,
} from './governance-confirm-dialog';
import { useGovernance } from './use-governance';

export function KanbanPage() {
  const projectRoot = useProjectRoot();
  const openNote = useOpenNote();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;

  const [searchQuery, setSearchQuery] = useState(search?.q || '');
  const debouncedSearch = useDebouncedValue(searchQuery, 250);
  const [viewMode, setViewMode] = useState<'kanban' | 'table'>('kanban');
  const [pendingConfirmAction, setPendingConfirmAction] =
    useState<GovernanceConfirmAction | null>(null);

  const kindFilter = search?.kind || '';

  // Synchronize debounced search input to URL `q` parameter
  useEffect(() => {
    const currentQ = (search?.q || '').trim();
    const nextQ = debouncedSearch.trim();
    if (currentQ !== nextQ) {
      navigate({
        to: '.',
        search: (prev: any) => {
          const next = { ...prev };
          if (nextQ) {
            next.q = nextQ;
          } else {
            delete next.q;
          }
          return next;
        },
        replace: true,
      });
    }
  }, [debouncedSearch, navigate, search?.q]);

  const handleKindChange = (val: string) => {
    navigate({
      to: '.',
      search: (prev: any) => {
        const next = { ...prev };
        if (val) {
          next.kind = val;
        } else {
          delete next.kind;
        }
        return next;
      },
      replace: true,
    });
  };

  const { data: notesData, isLoading } = useQuery({
    ...notesQuery(projectRoot, {
      query: debouncedSearch.trim() || undefined,
      kind: kindFilter || undefined,
    }),
    placeholderData: keepPreviousData,
  });

  const governanceMutation = useGovernance(projectRoot);

  const items = notesData?.items ?? [];

  const candidates = useMemo(
    () => items.filter((n) => columnForStatus(n.status) === 'candidates'),
    [items],
  );
  const verified = useMemo(
    () => items.filter((n) => columnForStatus(n.status) === 'verified'),
    [items],
  );
  const archived = useMemo(
    () => items.filter((n) => columnForStatus(n.status) === 'archived'),
    [items],
  );

  const handlePromote = (recordId: string) => {
    governanceMutation.mutate({ action: 'promote', recordId });
  };

  const handleInspect = (recordId: string) => {
    openNote(recordId);
  };

  const handleOpenInGraph = (recordId: string) => {
    navigate({
      to: '/graph',
      search: (prev: any) => ({
        ...prev,
        project: projectRoot,
        node: recordId,
      }),
    });
  };

  const handleExpire = (recordId: string, title: string) => {
    setPendingConfirmAction({ action: 'expire', recordId, title });
  };

  const handleRetract = (recordId: string, title: string) => {
    setPendingConfirmAction({ action: 'retract', recordId, title });
  };

  const handleConfirmAction = (reason: string) => {
    if (!pendingConfirmAction) return;
    const { action, recordId } = pendingConfirmAction;
    governanceMutation.mutate(
      {
        action,
        recordId,
        reason: reason.trim() || undefined,
      },
      {
        onSettled: () => {
          setPendingConfirmAction(null);
        },
      },
    );
  };

  const handleQuickEntrySubmit = (data: {
    action: QuickEntryKind;
    title: string;
    summary: string;
    content: string;
  }) => {
    governanceMutation.mutate(data);
  };

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-7xl mx-auto">
      <QuickEntry
        onSubmit={handleQuickEntrySubmit}
        isPending={governanceMutation.isPending}
      />

      <KanbanToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        kindFilter={kindFilter}
        onKindChange={handleKindChange}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      {isLoading && !notesData ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      ) : viewMode === 'table' ? (
        <NotesTable
          notes={items}
          onPromote={handlePromote}
          onInspect={handleInspect}
          onOpenInGraph={handleOpenInGraph}
          onExpire={handleExpire}
          onRetract={handleRetract}
          isPending={governanceMutation.isPending}
        />
      ) : (
        <KanbanBoard
          candidates={candidates}
          verified={verified}
          archived={archived}
          onPromote={handlePromote}
          onInspect={handleInspect}
          onOpenInGraph={handleOpenInGraph}
          onExpire={handleExpire}
          onRetract={handleRetract}
          isPending={governanceMutation.isPending}
        />
      )}

      <GovernanceConfirmDialog
        action={pendingConfirmAction}
        open={Boolean(pendingConfirmAction)}
        onOpenChange={(open) => {
          if (!open) setPendingConfirmAction(null);
        }}
        onConfirm={handleConfirmAction}
        isPending={governanceMutation.isPending}
      />
    </div>
  );
}
