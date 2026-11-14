import { Kanban, Table2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export interface KanbanToolbarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  kindFilter: string;
  onKindChange: (value: string) => void;
  viewMode: 'kanban' | 'table';
  onViewModeChange: (mode: 'kanban' | 'table') => void;
}

export function KanbanToolbar({
  searchQuery,
  onSearchChange,
  kindFilter,
  onKindChange,
  viewMode,
  onViewModeChange,
}: KanbanToolbarProps) {
  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2.5 flex-1 min-w-[280px]">
        <Input
          id="kanban-search-input"
          type="text"
          placeholder="พิมพ์ค้นหาความจำ ชื่อไฟล์ หรือฟังก์ชัน... (Ctrl+K)"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-9 text-xs"
        />

        <select
          id="kanban-kind-filter"
          value={kindFilter}
          onChange={(e) => onKindChange(e.target.value)}
          className="h-9 w-[160px] shrink-0 rounded-md border border-input bg-card px-2.5 py-1 text-xs text-foreground shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
        >
          <option value="">ทุกหมวดหมู่</option>
          <option value="adr">ADR</option>
          <option value="insight">Insight</option>
          <option value="mistake">Mistake</option>
          <option value="session-log">Session Log</option>
        </select>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          type="button"
          variant={viewMode === 'kanban' ? 'default' : 'secondary'}
          size="sm"
          onClick={() => onViewModeChange('kanban')}
          className="h-9 gap-1.5 text-xs"
        >
          <Kanban className="size-3.5" />
          <span>มุมมองบอร์ด (Kanban)</span>
        </Button>
        <Button
          type="button"
          variant={viewMode === 'table' ? 'default' : 'secondary'}
          size="sm"
          onClick={() => onViewModeChange('table')}
          className="h-9 gap-1.5 text-xs"
        >
          <Table2 className="size-3.5" />
          <span>มุมมองตาราง (Table)</span>
        </Button>
      </div>
    </div>
  );
}
