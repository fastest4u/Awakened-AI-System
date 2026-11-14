import { useState } from 'react';
import { useProjectRoot } from '@/hooks/use-project-root';
import { CuratorChat, type ChatMessage } from './curator-chat';
import { AutoCurateCard } from './auto-curate-card';

const INITIAL_WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  role: 'ai',
  text: 'สวัสดีครับ! ผมคือ AI Memory Curator Agent (React + TanStack MVC) พร้อมช่วยตรวจสอบคลังความจำ อนุมัติ Candidate ยุบรวมความจำซ้ำ และบันทึก ADR/Insight/Mistake ให้ทุกโปรเจกต์ครับ',
  tools: [],
};

export function CuratorPage() {
  const projectRoot = useProjectRoot();
  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_WELCOME_MESSAGE]);

  const handleAddChatMessage = (msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
      <CuratorChat
        projectRoot={projectRoot}
        messages={messages}
        setMessages={setMessages}
      />
      <AutoCurateCard
        projectRoot={projectRoot}
        onAddChatMessage={handleAddChatMessage}
      />
    </div>
  );
}
