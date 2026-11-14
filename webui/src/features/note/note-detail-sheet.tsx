import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch, useNavigate } from '@tanstack/react-router';
import {
  FileText,
  X,
  Share2,
  Sparkles,
  FileCode,
  Code2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { KindBadge } from '@/components/shared/kind-badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { CopyButton } from '@/components/shared/copy-button';
import { noteQuery } from '@/api/queries';
import { useProjectRoot } from '@/hooks/use-project-root';
import { useOpenNote } from '@/hooks/use-open-note';
import { extractNoteBodyText, deriveHumanTitle } from '@/lib/note';
import { InlineMarkdown, MarkdownBlocks } from '@/lib/markdown';

export function NoteDetailSheet() {
  const [showRawJson, setShowRawJson] = useState(false);
  const openNote = useOpenNote();
  const navigate = useNavigate();
  const projectRoot = useProjectRoot();

  let noteId: string | undefined;
  try {
    const search = useSearch({ strict: false }) as any;
    noteId = search?.note;
  } catch {
    // router context not ready
  }

  const isOpen = Boolean(noteId);

  const { data, isLoading, isError, error } = useQuery({
    ...noteQuery(projectRoot, noteId || ''),
    enabled: isOpen,
  });

  const note = data?.note;

  const handleClose = () => {
    openNote(null);
  };

  const handleWikilink = (target: string) => {
    if (target.startsWith('note:')) {
      openNote(target.slice(5));
    } else {
      navigate({
        to: '/kanban',
        search: (prev: any) => {
          const next = {
            ...prev,
            project: projectRoot,
            q: target,
          };
          delete next.note;
          return next;
        },
      });
    }
  };

  const handleGraphFocus = () => {
    if (!note?.recordId) return;
    const targetRecordId = note.recordId;
    navigate({
      to: '/graph',
      search: (prev: any) => {
        const next = { ...prev, project: projectRoot, node: targetRecordId };
        delete next.note;
        return next;
      },
    });
  };

  const handleGraphQuery = (queryVal: string) => {
    navigate({
      to: '/graph',
      search: (prev: any) => {
        const next = {
          ...prev,
          project: projectRoot,
          q: queryVal,
        };
        delete next.note;
        return next;
      },
    });
  };

  const bodyText = note ? extractNoteBodyText(note.body ?? (note as any).content) : '';
  const humanTitle = note ? deriveHumanTitle(note) : '';
  const summaryText = note?.summary || note?.title || humanTitle;

  const rawMarkdownToCopy =
    bodyText ||
    (note
      ? `# ${note.title || note.recordId}\n\n${note.summary || ''}`
      : '');

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl p-0 flex flex-col gap-0 border-l border-border bg-card shadow-2xl"
        showCloseButton={false}
      >
        <SheetHeader className="flex flex-row items-center justify-between border-b border-border px-6 py-4 space-y-0">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileText className="size-4" />
            </div>
            <SheetTitle className="text-base font-semibold text-foreground">
              รายละเอียดความจำ (Human-Readable Memory View)
            </SheetTitle>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClose}
            className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
            <span>ปิดหน้าต่าง</span>
          </Button>
        </SheetHeader>

        <SheetDescription className="sr-only">
          หน้าต่างแสดงรายละเอียดความจำ บทเรียน หรือการตัดสินใจ
        </SheetDescription>

        <ScrollArea className="flex-1 p-6">
          {isError ? (
            <div className="py-4">
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertDescription className="text-sm font-medium">
                  ไม่พบข้อมูลความจำที่ระบุ หรือรายการนี้อาจถูกยกเลิก/ยุบรวมไปแล้ว
                  {error?.message ? ` (${error.message})` : ''}
                </AlertDescription>
              </Alert>
            </div>
          ) : isLoading || !note ? (
            <div className="space-y-5 py-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-6 w-28 rounded-full" />
                <Skeleton className="h-6 w-24 rounded-full" />
              </div>
              <Skeleton className="h-8 w-3/4 rounded-md" />
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-44 w-full rounded-lg" />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {/* Badges & Actions row */}
              <div className="flex flex-wrap items-center gap-2">
                <KindBadge kind={note.recordKind || note.kind} />
                <StatusBadge status={note.status} />

                {note.recordId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs"
                    onClick={handleGraphFocus}
                  >
                    <Share2 className="size-3 text-muted-foreground" />
                    <span>ดูความเชื่อมโยงในกราฟ</span>
                  </Button>
                ) : null}

                {note.recordId ? (
                  <CopyButton
                    value={note.recordId}
                    label="คัดลอก ID"
                    toastMessage={`คัดลอก Record ID แล้ว: ${note.recordId}`}
                  />
                ) : null}

                <CopyButton
                  value={rawMarkdownToCopy}
                  label="คัดลอก Markdown"
                  toastMessage="คัดลอกเนื้อหา Markdown แล้ว"
                />
              </div>

              {/* Note Title */}
              <h2 className="text-xl font-bold leading-snug tracking-tight text-foreground">
                {humanTitle}
              </h2>

              {/* Key Takeaway Box */}
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-primary">
                  <Sparkles className="size-3.5 text-amber-500 shrink-0" />
                  <span>สรุปใจความสำคัญ (Key Takeaway)</span>
                </div>
                <div className="text-sm leading-relaxed text-foreground">
                  <InlineMarkdown
                    text={summaryText}
                    onWikilink={handleWikilink}
                  />
                </div>
              </div>

              {/* Full Markdown Body */}
              {bodyText ? (
                <div className="rounded-lg border border-border bg-background p-4 text-foreground">
                  <MarkdownBlocks
                    text={bodyText}
                    onWikilink={handleWikilink}
                  />
                </div>
              ) : null}

              {/* Associated Files and Symbols */}
              {((note.filePaths && note.filePaths.length > 0) ||
                (note.symbols && note.symbols.length > 0)) && (
                <div className="rounded-lg border border-border bg-card p-4 space-y-2.5">
                  <div className="text-xs font-semibold text-muted-foreground">
                    ไฟล์และสัญลักษณ์ที่เกี่ยวข้อง (
                    {note.filePaths?.length || 0} ไฟล์,{' '}
                    {note.symbols?.length || 0} สัญลักษณ์)
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {note.filePaths?.map((fp) => (
                      <Badge
                        key={`fp-${fp}`}
                        variant="outline"
                        className="cursor-pointer gap-1 text-xs hover:bg-accent"
                        onClick={() => handleGraphQuery(fp)}
                      >
                        <FileCode className="size-3 text-muted-foreground" />
                        <span>{fp}</span>
                      </Badge>
                    ))}
                    {note.symbols?.map((sym) => (
                      <Badge
                        key={`sym-${sym}`}
                        variant="secondary"
                        className="cursor-pointer gap-1 text-xs hover:bg-accent"
                        onClick={() => handleGraphQuery(sym)}
                      >
                        <Code2 className="size-3 text-muted-foreground" />
                        <span>{sym}</span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Collapsible Raw JSON */}
              <Collapsible
                open={showRawJson}
                onOpenChange={setShowRawJson}
                className="pt-1"
              >
                <div className="flex items-center justify-between">
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {showRawJson ? (
                        <ChevronUp className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                      <span>
                        {showRawJson
                          ? 'ซ่อนข้อมูลเทคนิค (Raw JSON)'
                          : 'ดูข้อมูลเทคนิคสำหรับนักพัฒนา (Raw JSON)'}
                      </span>
                    </Button>
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent className="pt-2">
                  <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/50 p-3 text-xs font-mono text-foreground">
                    <code>{JSON.stringify(note, null, 2)}</code>
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
