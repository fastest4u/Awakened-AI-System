import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Cpu,
  Network,
  ArrowRight,
  Activity,
  Clock,
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  ShieldCheck,
  Layers,
  FileText,
  Bot,
} from 'lucide-react';
import { useOpenNote } from '@/hooks/use-open-note';
import { useNavigate } from '@tanstack/react-router';

export interface SessionItem {
  sessionId: string;
  currentTask?: string;
  semanticState?: 'active' | 'ending' | 'abandoned' | 'ended' | string;
  kind?: 'root' | 'child' | string;
  noteCount?: number;
  noteTitles?: string[];
  noteIds?: string[];
  inProgressItems?: string[];
  filesTouched?: string[];
}

export interface SessionActivityMapProps {
  sessions?: SessionItem[] | null;
}

export function SessionActivityMap({ sessions }: SessionActivityMapProps) {
  const openNote = useOpenNote();
  const navigate = useNavigate();

  const sessionList = Array.isArray(sessions) ? sessions : [];

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cpu className="size-4.5 text-[#38bdf8]" />
              <span>
                แผนผังความสัมพันธ์แต่ละเซสชัน & ความจำ (AI Session Activity &
                Memory Map)
              </span>
            </CardTitle>
            <CardDescription>
              แสดงว่าในแต่ละเซสชัน (Session) AI กำลังทำอะไรอยู่ แก้ไขไฟล์ไหน
              และสร้างความจำ (Memory Note) อะไรไว้บ้าง
            </CardDescription>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() =>
              navigate({
                to: '/graph',
                search: (prev: any) => ({ ...prev }),
              })
            }
          >
            <Network className="size-3.5 text-[#38bdf8]" />
            <span>เปิดกราฟความสัมพันธ์เต็มรูปแบบ</span>
            <ArrowRight className="size-3" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {sessionList.length === 0 ? (
          <Alert>
            <AlertTitle>ยังไม่มีเซสชันที่บันทึกไว้ในโปรเจกต์นี้</AlertTitle>
            <AlertDescription>
              เมื่อ AI Agent เริ่มทำงานด้วย memory_sessionStart
              ระบบจะแสดงความสัมพันธ์ของเซสชันและความจำที่นี่อัตโนมัติ
            </AlertDescription>
          </Alert>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {sessionList.slice(0, 6).map((s) => {
              const isActive = s.semanticState === 'active';
              const isEnding = s.semanticState === 'ending';
              const isAbandoned = s.semanticState === 'abandoned';
              const noteTitles = Array.isArray(s.noteTitles) ? s.noteTitles : [];
              const noteIds = Array.isArray(s.noteIds) ? s.noteIds : [];
              const inProgress = Array.isArray(s.inProgressItems)
                ? s.inProgressItems
                : [];
              const filesTouched = Array.isArray(s.filesTouched)
                ? s.filesTouched
                : [];

              const rawTask = String(
                s.currentTask ||
                  (isActive
                    ? 'กำลังประมวลผลภารกิจปัจจุบัน'
                    : 'เซสชันการดูแลคลังความจำ'),
              ).trim();
              const shortTask =
                rawTask.length > 96 ? rawTask.slice(0, 95) + '…' : rawTask;

              let headline = shortTask;
              if (isActive) {
                headline = `AI กำลังทำ: ${shortTask}`;
              } else if (isEnding) {
                headline = `กำลังสรุปปิดงาน: ${shortTask}`;
              }

              const totalNotes = s.noteCount ?? noteTitles.length ?? 0;

              return (
                <div
                  key={s.sessionId}
                  className="p-3.5 rounded-xl border bg-card/50 flex flex-col gap-2.5 transition-colors"
                  style={{
                    borderColor: isActive
                      ? 'rgba(16, 185, 129, 0.4)'
                      : isEnding
                        ? 'rgba(245, 158, 11, 0.4)'
                        : undefined,
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge
                        variant={
                          isActive
                            ? 'success'
                            : isEnding
                              ? 'warning'
                              : isAbandoned
                                ? 'destructive'
                                : 'secondary'
                        }
                      >
                        {isActive ? (
                          <Activity className="size-3" />
                        ) : isEnding ? (
                          <Clock className="size-3" />
                        ) : isAbandoned ? (
                          <AlertTriangle className="size-3" />
                        ) : (
                          <CheckCircle2 className="size-3" />
                        )}
                        <span>
                          {isActive
                            ? 'AI กำลังทำงาน (Active)'
                            : isEnding
                              ? 'กำลังปิดเซสชัน (Ending)'
                              : isAbandoned
                                ? 'ยกเลิกกลางคัน (Abandoned)'
                                : 'เสร็จสิ้น (Ended)'}
                        </span>
                      </Badge>
                      <Badge variant="outline">
                        {s.kind === 'child' ? (
                          <GitBranch className="size-3" />
                        ) : (
                          <ShieldCheck className="size-3" />
                        )}
                        <span>{s.kind === 'child' ? 'Subagent' : 'Root Agent'}</span>
                      </Badge>
                    </div>
                    <code className="text-[11px] text-muted-foreground font-mono">
                      #{String(s.sessionId || '').slice(0, 8)}
                    </code>
                  </div>

                  <div className="flex items-start gap-2 text-xs font-semibold text-foreground">
                    {isActive ? (
                      <Bot className="size-4 shrink-0 text-[#10b981] mt-0.5" />
                    ) : isEnding ? (
                      <Clock className="size-4 shrink-0 text-[#f59e0b] mt-0.5" />
                    ) : (
                      <CheckCircle2 className="size-4 shrink-0 text-[#38bdf8] mt-0.5" />
                    )}
                    <span className="line-clamp-2 leading-snug">{headline}</span>
                  </div>

                  {inProgress.length > 0 && (
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Clock className="size-3 shrink-0" />
                      <span className="truncate">
                        งานย่อย: {inProgress.slice(0, 2).join(' • ')}
                      </span>
                    </div>
                  )}

                  <div className="space-y-1 mt-0.5">
                    <div className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                      <Layers className="size-3 text-[#6366f1]" />
                      <span>
                        ความจำที่เชื่อมโยงกับเซสชันนี้ ({totalNotes} รายการ)
                        {noteTitles.length > 0 ? ':' : ''}
                      </span>
                    </div>

                    {noteTitles.length === 0 ? (
                      isActive || isEnding ? (
                        <p className="text-[11px] text-muted-foreground italic">
                          ยังไม่มีความจำใหม่ในเซสชันนี้
                        </p>
                      ) : null
                    ) : (
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {noteTitles.slice(0, 5).map((title, idx) => {
                          const nid = noteIds[idx];
                          return (
                            <button
                              key={(nid || title) + idx}
                              type="button"
                              onClick={() => nid && openNote(nid)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors cursor-pointer"
                            >
                              <FileText className="size-3 text-[#6366f1]" />
                              <span className="max-w-[140px] truncate">
                                {title}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {filesTouched.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1 mt-auto">
                      {filesTouched.slice(0, 3).map((fp) => (
                        <Badge
                          key={fp}
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 h-5"
                        >
                          <FileText className="size-2.5 text-muted-foreground" />
                          <span className="max-w-[120px] truncate">{fp}</span>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
