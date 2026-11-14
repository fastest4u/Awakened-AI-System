import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  LayoutDashboard,
  Kanban,
  Network,
  Bot,
  Wrench,
  RefreshCw,
  SunMoon,
  Sparkles,
} from 'lucide-react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import { useTheme } from '@/providers/theme-provider';
import { useProjectRoot } from '@/hooks/use-project-root';
import { invalidateProject } from '@/api/queries';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectRoot = useProjectRoot();
  const { toggleTheme } = useTheme();

  const handleSelect = (action: () => void) => {
    action();
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="เมนูคำสั่งด่วน"
      description="ค้นหาเมนู ความจำ หรือคำสั่งเพื่อทำงานทันที"
    >
      <CommandInput placeholder="ค้นหาเมนู ความจำ หรือคำสั่ง..." />
      <CommandList>
        <CommandEmpty>ไม่พบคำสั่งที่ค้นหา</CommandEmpty>
        <CommandGroup heading="เมนูหลัก (Navigation)">
          <CommandItem
            onSelect={() =>
              handleSelect(() =>
                navigate({
                  to: '/overview',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
            onClick={() =>
              handleSelect(() =>
                navigate({
                  to: '/overview',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
          >
            <LayoutDashboard className="mr-2 h-4 w-4" />
            <span>ภาพรวม & กราฟ</span>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              handleSelect(() =>
                navigate({
                  to: '/kanban',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
            onClick={() =>
              handleSelect(() =>
                navigate({
                  to: '/kanban',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
          >
            <Kanban className="mr-2 h-4 w-4" />
            <span>จัดการความจำ</span>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              handleSelect(() =>
                navigate({
                  to: '/graph',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
            onClick={() =>
              handleSelect(() =>
                navigate({
                  to: '/graph',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
          >
            <Network className="mr-2 h-4 w-4" />
            <span>กราฟเชื่อมโยง</span>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              handleSelect(() =>
                navigate({
                  to: '/curator',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
            onClick={() =>
              handleSelect(() =>
                navigate({
                  to: '/curator',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
          >
            <Bot className="mr-2 h-4 w-4" />
            <span>ผู้ช่วย AI ดูแลความจำ</span>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              handleSelect(() =>
                navigate({
                  to: '/mcp',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
            onClick={() =>
              handleSelect(() =>
                navigate({
                  to: '/mcp',
                  search: (prev: any) => ({ project: prev.project }),
                }),
              )
            }
          >
            <Wrench className="mr-2 h-4 w-4" />
            <span>เครื่องมือนักพัฒนา</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="คำสั่งด่วน (Actions)">
          <CommandItem
            onSelect={() =>
              handleSelect(async () => {
                await invalidateProject(queryClient, projectRoot);
                toast.success('รีเฟรชข้อมูลเรียบร้อย');
              })
            }
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            <span>รีเฟรชข้อมูล</span>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              handleSelect(() => {
                navigate({
                  to: '/curator',
                  search: (prev: any) => ({ project: prev.project }),
                });
              })
            }
          >
            <Sparkles className="mr-2 h-4 w-4" />
            <span>ให้ AI จัดระเบียบ</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSelect(() => toggleTheme())}>
            <SunMoon className="mr-2 h-4 w-4" />
            <span>สลับโหมดสี (Dark / Light)</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
