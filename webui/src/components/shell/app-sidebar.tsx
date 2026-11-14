import { Link, useRouterState } from '@tanstack/react-router';
import {
  Cpu,
  LayoutDashboard,
  Kanban,
  Network,
  Bot,
  Wrench,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export const NAV_ITEMS = [
  {
    id: 'overview',
    href: '/overview',
    icon: LayoutDashboard,
    label: 'ภาพรวม & กราฟ',
    subtitle: 'Overview & Analytics',
  },
  {
    id: 'kanban',
    href: '/kanban',
    icon: Kanban,
    label: 'จัดการความจำ',
    subtitle: 'Kanban & Table',
  },
  {
    id: 'graph',
    href: '/graph',
    icon: Network,
    label: 'กราฟเชื่อมโยง',
    subtitle: 'Knowledge Graph',
  },
  {
    id: 'curator',
    href: '/curator',
    icon: Bot,
    label: 'ผู้ช่วย AI ดูแลความจำ',
    subtitle: 'AI Memory Curator',
  },
  {
    id: 'mcp',
    href: '/mcp',
    icon: Wrench,
    label: 'เครื่องมือนักพัฒนา',
    subtitle: '34 MCP Tools',
  },
] as const;

export function AppSidebar({ className }: { className?: string }) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <aside
      className={cn(
        'hidden lg:flex flex-col w-64 shrink-0 border-r border-border bg-card/60 backdrop-blur-md select-none',
        className,
      )}
    >
      {/* Brand Header */}
      <div className="flex items-center gap-3 p-4 border-b border-border">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#6366f1] to-[#10b981] text-white shadow-md">
          <Cpu className="h-5 w-5" />
        </div>
        <div className="flex flex-col min-w-0">
          <h1 className="text-base font-bold tracking-tight text-foreground truncate">
            Memory Studio
          </h1>
          <p className="text-xs text-muted-foreground truncate">
            Project Memory V2
          </p>
        </div>
      </div>

      {/* Nav List */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = currentPath === item.href;

          return (
            <Link
              key={item.id}
              to={item.href}
              search={(prev: any) =>
                prev.project ? { project: prev.project } : {}
              }
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0 transition-colors',
                  isActive
                    ? 'text-primary'
                    : 'text-muted-foreground group-hover:text-foreground',
                )}
              />
              <div className="flex flex-col min-w-0">
                <span className="truncate">{item.label}</span>
                <span className="text-[10px] text-muted-foreground/80 font-normal truncate">
                  {item.subtitle}
                </span>
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Sidebar Footer */}
      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2 text-[11px] text-muted-foreground">
          <Zap className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="truncate font-mono">
            Vite + React + TanStack + shadcn/ui
          </span>
        </div>
      </div>
    </aside>
  );
}
