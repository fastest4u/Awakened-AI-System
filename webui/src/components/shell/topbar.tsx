import { useNavigate } from '@tanstack/react-router';
import { useQueryClient, useIsFetching } from '@tanstack/react-query';
import { RefreshCw, Sparkles, Sun, Moon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ProjectSwitcher } from './project-switcher';
import { useTheme } from '@/providers/theme-provider';
import { useProjectRoot } from '@/hooks/use-project-root';
import { pmKeys, invalidateProject } from '@/api/queries';

export function Topbar() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectRoot = useProjectRoot();
  const { theme, toggleTheme } = useTheme();

  const isSyncing =
    useIsFetching({
      queryKey: pmKeys.overview(projectRoot),
    }) > 0;

  const handleRefresh = async () => {
    try {
      await invalidateProject(queryClient, projectRoot);
      toast.success('รีเฟรชข้อมูลเรียบร้อย');
    } catch {
      toast.error('ไม่สามารถรีเฟรชข้อมูลได้');
    }
  };

  const handleCurator = () => {
    navigate({
      to: '/curator',
      search: (prev: any) => ({ project: prev.project }),
    });
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 w-full items-center justify-between border-b border-border bg-card/80 px-4 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <ProjectSwitcher />
        {isSyncing && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground animate-pulse">
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" />
            <span className="hidden sm:inline">กำลังซิงก์ข้อมูล...</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          className="h-8 gap-1.5 text-xs"
        >
          <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="hidden sm:inline">รีเฟรชข้อมูล</span>
        </Button>

        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handleCurator}
          className="h-8 gap-1.5 text-xs bg-gradient-to-r from-[#6366f1] to-[#10b981] text-white hover:opacity-90"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>ให้ AI จัดระเบียบ</span>
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={toggleTheme}
          aria-label={
            theme === 'dark' ? 'โหมดสว่าง (Light)' : 'โหมดมืด (Dark)'
          }
          className="h-8 gap-1.5 text-xs"
        >
          {theme === 'dark' ? (
            <>
              <Sun className="h-4 w-4 text-amber-400" />
              <span className="hidden md:inline">โหมดสว่าง (Light)</span>
            </>
          ) : (
            <>
              <Moon className="h-4 w-4 text-indigo-500" />
              <span className="hidden md:inline">โหมดมืด (Dark)</span>
            </>
          )}
        </Button>
      </div>
    </header>
  );
}
