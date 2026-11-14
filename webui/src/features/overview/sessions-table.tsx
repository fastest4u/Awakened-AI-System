import { useState, useMemo } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Clock,
  ChevronUp,
  ChevronDown,
  Layers,
  Activity,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import type { SessionItem } from './session-activity-map';

export interface SessionsTableProps {
  sessions?: SessionItem[] | null;
}

type SortColumn = 'sessionId' | 'currentTask' | 'noteCount' | 'semanticState';
type SortDirection = 'asc' | 'desc';

export function SessionsTable({ sessions }: SessionsTableProps) {
  const [filter, setFilter] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const sessionList = useMemo(
    () => (Array.isArray(sessions) ? sessions : []),
    [sessions],
  );

  const filteredAndSortedSessions = useMemo(() => {
    let result = [...sessionList];

    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      result = result.filter((s) => {
        const idMatch = String(s.sessionId || '').toLowerCase().includes(q);
        const taskMatch = String(s.currentTask || '').toLowerCase().includes(q);
        const stateMatch = String(s.semanticState || '').toLowerCase().includes(q);
        return idMatch || taskMatch || stateMatch;
      });
    }

    if (sortColumn) {
      result.sort((a, b) => {
        let valA: string | number = '';
        let valB: string | number = '';

        if (sortColumn === 'sessionId') {
          valA = a.sessionId || '';
          valB = b.sessionId || '';
        } else if (sortColumn === 'currentTask') {
          valA = a.currentTask || '';
          valB = b.currentTask || '';
        } else if (sortColumn === 'noteCount') {
          valA = a.noteCount ?? a.noteTitles?.length ?? 0;
          valB = b.noteCount ?? b.noteTitles?.length ?? 0;
        } else if (sortColumn === 'semanticState') {
          valA = a.semanticState || '';
          valB = b.semanticState || '';
        }

        if (typeof valA === 'number' && typeof valB === 'number') {
          return sortDirection === 'asc' ? valA - valB : valB - valA;
        }

        const comp = String(valA).localeCompare(String(valB));
        return sortDirection === 'asc' ? comp : -comp;
      });
    }

    return result;
  }, [sessionList, filter, sortColumn, sortDirection]);

  const toggleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else {
        setSortColumn(null);
        setSortDirection('asc');
      }
    } else {
      setSortColumn(col);
      setSortDirection('asc');
    }
  };

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="size-4.5 text-[#38bdf8]" />
              <span>ประวัติเซสชันล่าสุด (Sessions)</span>
            </CardTitle>
            <CardDescription>
              คลิกหัวตารางเพื่อเรียงลำดับ (TanStack Table)
            </CardDescription>
          </div>
          <Input
            id="session-table-filter"
            placeholder="ค้นหาเซสชัน..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-[190px] h-8 text-xs"
          />
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                className="cursor-pointer select-none text-xs"
                onClick={() => toggleSort('sessionId')}
              >
                <div className="flex items-center gap-1">
                  <span>Session ID</span>
                  {sortColumn === 'sessionId' &&
                    (sortDirection === 'asc' ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    ))}
                </div>
              </TableHead>
              <TableHead
                className="cursor-pointer select-none text-xs"
                onClick={() => toggleSort('currentTask')}
              >
                <div className="flex items-center gap-1">
                  <span>ภารกิจ AI (Task)</span>
                  {sortColumn === 'currentTask' &&
                    (sortDirection === 'asc' ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    ))}
                </div>
              </TableHead>
              <TableHead
                className="cursor-pointer select-none text-xs"
                onClick={() => toggleSort('noteCount')}
              >
                <div className="flex items-center gap-1">
                  <span>ความจำ</span>
                  {sortColumn === 'noteCount' &&
                    (sortDirection === 'asc' ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    ))}
                </div>
              </TableHead>
              <TableHead
                className="cursor-pointer select-none text-xs"
                onClick={() => toggleSort('semanticState')}
              >
                <div className="flex items-center gap-1">
                  <span>สถานะ</span>
                  {sortColumn === 'semanticState' &&
                    (sortDirection === 'asc' ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    ))}
                </div>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAndSortedSessions.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-center text-xs text-muted-foreground py-6"
                >
                  ยังไม่มีประวัติเซสชัน
                </TableCell>
              </TableRow>
            ) : (
              filteredAndSortedSessions.slice(0, 8).map((s) => {
                const isActive = s.semanticState === 'active';
                const isEnding = s.semanticState === 'ending';
                const isAbandoned = s.semanticState === 'abandoned';
                const isEnded = s.semanticState === 'ended';

                const rawTask = String(
                  s.currentTask ||
                    (isActive
                      ? 'Active AI Session'
                      : 'เซสชันการดูแลคลังความจำ'),
                ).trim();
                const shortTask =
                  rawTask.length > 88 ? rawTask.slice(0, 87) + '…' : rawTask;

                const noteTotal = s.noteCount ?? s.noteTitles?.length ?? 0;

                return (
                  <TableRow key={s.sessionId} className="text-xs">
                    <TableCell className="font-mono text-primary text-[11px]">
                      {String(s.sessionId || '').slice(0, 10)}...
                    </TableCell>
                    <TableCell className="font-medium max-w-[200px] truncate" title={rawTask}>
                      {shortTask}
                    </TableCell>
                    <TableCell>
                      <Badge variant="default" className="text-[10px] gap-1 px-1.5 py-0 h-5">
                        <Layers className="size-2.5" />
                        <span>{noteTotal}</span>
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          isActive
                            ? 'success'
                            : isEnding
                              ? 'warning'
                              : isAbandoned
                                ? 'destructive'
                                : 'outline'
                        }
                        className="text-[10px] gap-1 px-1.5 py-0 h-5"
                      >
                        {isActive ? (
                          <Activity className="size-2.5" />
                        ) : isEnding ? (
                          <Clock className="size-2.5" />
                        ) : isEnded ? (
                          <CheckCircle2 className="size-2.5" />
                        ) : isAbandoned ? (
                          <AlertTriangle className="size-2.5" />
                        ) : null}
                        <span>
                          {isActive
                            ? 'กำลังทำงาน'
                            : isEnding
                              ? 'กำลังปิดเซสชัน'
                              : isEnded
                                ? 'เสร็จสิ้น'
                                : isAbandoned
                                  ? 'ยกเลิก'
                                  : s.semanticState || ''}
                        </span>
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
