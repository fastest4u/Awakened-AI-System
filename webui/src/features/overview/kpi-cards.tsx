import { StatCard } from '@/components/shared/stat-card';

export interface KpiCardsProps {
  healthScore?: number | null;
  counts?: {
    verifiedNotes?: number;
    activeNotes?: number;
    unpromotedCandidates?: number;
    conflictedNotes?: number;
    duplicateGroups?: number;
    duplicateGroupCount?: number;
    staleItems?: number;
  } | null;
}

export function KpiCards({ healthScore = 0, counts }: KpiCardsProps) {
  const score = healthScore ?? 0;
  const verified = counts?.verifiedNotes ?? counts?.activeNotes ?? 0;
  const candidates = counts?.unpromotedCandidates ?? 0;
  const duplicateCount =
    counts?.duplicateGroups ?? counts?.duplicateGroupCount ?? 0;
  const conflicts = (counts?.conflictedNotes ?? 0) + duplicateCount;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        label="คะแนนสุขภาพคลังความจำ"
        value={`${score}/100`}
        tone={score >= 85 ? 'emerald' : 'amber'}
        subtitle="Vault Health Score"
      />
      <StatCard
        label="ความจำที่ยืนยันแล้ว"
        value={String(verified)}
        tone="indigo"
        subtitle="Active / Verified Notes"
      />
      <StatCard
        label="รออนุมัติ (Candidates)"
        value={String(candidates)}
        tone="amber"
        subtitle="Provisional Queue"
      />
      <StatCard
        label="ความจำซ้ำ / ขัดแย้ง"
        value={String(conflicts)}
        tone={conflicts > 0 ? 'rose' : 'emerald'}
        subtitle="Conflicts & Duplicates"
      />
    </div>
  );
}
