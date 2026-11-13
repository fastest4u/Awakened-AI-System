import { Cpu } from 'lucide-react';

export default function App() {
  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-6">
      <div className="flex items-center gap-4 p-6 rounded-2xl border border-border bg-card shadow-lg">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-[#6366f1] to-[#10b981] text-white shadow-md">
          <Cpu className="h-7 w-7" />
        </div>
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold tracking-tight">Memory Studio</h1>
          <p className="text-sm text-muted-foreground">Project Memory V2</p>
        </div>
      </div>
    </main>
  );
}
