import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Send, Search, Sparkles, Zap, Wrench } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { isImeComposing } from '@/lib/keyboard';
import { apiPost } from '@/api/client';
import { invalidateProject } from '@/api/queries';
import type { CuratorChatReply } from '@/api/types';
import { toast } from 'sonner';

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
  tools: string[];
}

export interface CuratorChatProps {
  projectRoot: string;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export function CuratorChat({
  projectRoot,
  messages,
  setMessages,
}: CuratorChatProps) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleChipClick = (template: string) => {
    setInput(template);
    textareaRef.current?.focus();
  };

  const handleSend = async (overrideText?: string) => {
    const text = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!text || isSending) return;

    if (!overrideText) {
      setInput('');
    }

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}-${Math.random()}`,
      role: 'user',
      text,
      tools: [],
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsSending(true);

    const autoExecute = !dryRun;

    try {
      const data = await apiPost<CuratorChatReply>('/api/curator/chat', {
        projectRoot,
        message: text,
        autoExecute,
      });

      const aiMsg: ChatMessage = {
        id: `ai-${Date.now()}-${Math.random()}`,
        role: 'ai',
        text: data.reply || JSON.stringify(data),
        tools: data.executedTools || [],
      };
      setMessages((prev) => [...prev, aiMsg]);

      if (autoExecute) {
        await invalidateProject(queryClient, projectRoot);
      }
    } catch (err: any) {
      const errMsg = `ส่งคำสั่งไม่สำเร็จ: ${err?.message || String(err)}`;
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: 'ai', text: errMsg, tools: [] },
      ]);
      toast.error(errMsg);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Bot className="size-5 text-[#6366f1]" />
          <span>ผู้ช่วย AI ดูแลความจำ (AI Memory Curator)</span>
        </CardTitle>
        <CardDescription className="text-xs">
          พิมพ์สั่งงานภาษาไทยหรืออังกฤษได้ทันที เช่น ค้นหา อนุมัติ หรือบันทึกความจำ
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        {/* Chat Messages Stream */}
        <div className="h-[330px] overflow-y-auto rounded-lg border border-border bg-background p-3.5 flex flex-col gap-2.5 mb-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap leading-relaxed ${
                m.role === 'user'
                  ? 'self-end bg-primary text-primary-foreground font-medium'
                  : 'self-start bg-secondary text-foreground'
              }`}
            >
              <div>{m.text}</div>
              {m.tools && m.tools.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.tools.map((t) => (
                    <Badge
                      key={t}
                      variant="outline"
                      className="text-[10px] gap-1 py-0 h-5 bg-background/50"
                    >
                      <Wrench className="size-2.5" />
                      <span>{t}</span>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={streamEndRef} />
        </div>

        {/* Chips & Dry-Run Toggle */}
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground mr-0.5">แม่แบบ:</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs px-2.5"
              onClick={() => handleChipClick('บันทึก ADR: ')}
            >
              + ADR
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs px-2.5"
              onClick={() => handleChipClick('บันทึก Insight: ')}
            >
              + Insight
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs px-2.5"
              onClick={() => handleChipClick('บันทึก Mistake: ')}
            >
              + Mistake
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs px-2.5"
              onClick={() => handleChipClick('ค้นหา ')}
            >
              ค้นหา
            </Button>
          </div>

          <label
            htmlFor="curator-dry-run-toggle"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
          >
            <input
              id="curator-dry-run-toggle"
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="size-3.5 rounded border-border text-primary focus:ring-primary cursor-pointer"
            />
            <span>โหมดจำลองก่อนเขียนจริง (Dry-Run)</span>
          </label>
        </div>

        {/* Chat Textarea & Send Button */}
        <div className="flex gap-2 mb-2.5 items-end">
          <Textarea
            id="curator-chat-input"
            ref={textareaRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="พิมพ์คำสั่งหรือคำถาม เช่น 'มีรายการรออนุมัติกี่อัน?', 'บันทึก ADR เรื่อง ...' (Enter ส่ง • Shift+Enter ขึ้นบรรทัดใหม่)"
            className="min-h-[54px] resize-y text-xs leading-relaxed"
          />
          <Button
            type="button"
            variant="default"
            onClick={() => handleSend()}
            disabled={isSending || !input.trim()}
            className="h-[54px] px-4 gap-1.5 shrink-0"
          >
            <Send className="size-3.5" />
            <span>{isSending ? '...' : 'ส่ง'}</span>
          </Button>
        </div>

        {/* Quick Prompts */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => handleSend('ช่วยตรวจสุขภาพความจำและหาความจำซ้ำ')}
            disabled={isSending}
          >
            <Search className="size-3" />
            <span>ตรวจสุขภาพความจำ</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => handleSend('อนุมัติ candidate ทั้งหมด')}
            disabled={isSending}
          >
            <Sparkles className="size-3 text-emerald-500" />
            <span>อนุมัติทั้งหมด</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => handleSend('สรุปงานค้างและบริบทโปรเจกต์')}
            disabled={isSending}
          >
            <Zap className="size-3 text-amber-500" />
            <span>สรุปบริบทโปรเจกต์</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
