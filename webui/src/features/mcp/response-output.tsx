import { Terminal } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { CopyButton } from '@/components/shared/copy-button';

interface ResponseOutputProps {
  output: string;
}

export function ResponseOutput({ output }: ResponseOutputProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="size-4 text-[#10b981]" />
            ผลลัพธ์ (Response Output)
          </CardTitle>
          <CopyButton
            value={output}
            label="คัดลอก JSON"
            toastMessage="คัดลอกผลลัพธ์ JSON แล้ว"
          />
        </div>
        <CardDescription>
          ข้อมูล JSON ที่ส่งกลับจากคลังความจำ V2
        </CardDescription>
      </CardHeader>
      <CardContent>
        <pre
          className="p-3.5 rounded-lg border border-border bg-background font-mono text-xs max-h-[360px] overflow-auto whitespace-pre-wrap break-all"
        >
          {output}
        </pre>
      </CardContent>
    </Card>
  );
}
