import { useState, useEffect } from 'react';
import { createRootRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { AppSidebar } from '@/components/shell/app-sidebar';
import { Topbar } from '@/components/shell/topbar';
import { MobileNav } from '@/components/shell/mobile-nav';
import { CommandPalette } from '@/components/shell/command-palette';
import { Toaster } from '@/components/ui/sonner';
import { validateAppSearch } from '@/lib/search';
import { isImeComposing, isEditableTarget } from '@/lib/keyboard';

function RootLayout() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return;

      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }

      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditableTarget(e.target as Element)) return;
        e.preventDefault();
        navigate({
          to: '/kanban',
          search: (prev: any) => ({ project: prev.project }),
        }).then(() => {
          setTimeout(() => {
            const el = document.getElementById('kanban-search-input');
            if (el) el.focus();
          }, 0);
        });
        setTimeout(() => {
          const el = document.getElementById('kanban-search-input');
          if (el) el.focus();
        }, 0);
        setTimeout(() => {
          const el = document.getElementById('kanban-search-input');
          if (el) el.focus();
        }, 50);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground font-sans antialiased">
      <AppSidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar />
        <MobileNav />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
      />
      <Toaster position="bottom-right" duration={4500} />
    </div>
  );
}

export const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>) =>
    validateAppSearch(search),
  component: RootLayout,
});
