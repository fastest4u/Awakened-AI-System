import { Link, useRouterState } from '@tanstack/react-router';
import { NAV_ITEMS } from './app-sidebar';
import { cn } from '@/lib/utils';

export function MobileNav({ className }: { className?: string }) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <nav
      className={cn(
        'lg:hidden flex items-center gap-1.5 overflow-x-auto border-b border-border bg-card/90 px-3 py-2 no-scrollbar',
        className,
      )}
    >
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
              'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
