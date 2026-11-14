import { useQuery } from '@tanstack/react-query';
import { useProjectRoot } from '@/hooks/use-project-root';
import { overviewQuery } from '@/api/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { KpiCards } from './kpi-cards';
import { HealthGaugeCard } from './health-gauge-card';
import { DistributionCard } from './distribution-card';
import { ActivityCard } from './activity-card';
import { SessionActivityMap } from './session-activity-map';
import { CausalTriadsCard } from './causal-triads-card';
import { RecommendationsCard } from './recommendations-card';
import { SessionsTable } from './sessions-table';

export function OverviewPage() {
  const projectRoot = useProjectRoot();
  const { data, isPending, isError, error } = useQuery(overviewQuery(projectRoot));

  if (isPending) {
    return (
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
        <Skeleton className="h-72 rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>เกิดข้อผิดพลาดในการโหลดข้อมูลภาพรวม</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'ไม่สามารถดึงข้อมูล Overview ได้'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const audit = data?.audit;
  const counts = audit?.counts || {};
  const duplicateGroupCount =
    counts.duplicateGroups ??
    counts.duplicateGroupCount ??
    (Array.isArray(audit?.duplicateGroups) ? audit.duplicateGroups.length : 0);

  const mergedCounts = {
    ...counts,
    duplicateGroups: duplicateGroupCount,
  };

  const healthScore = audit?.healthScore ?? 0;
  const analytics = data?.analytics || {};
  const sessions = data?.lifecycle?.sessions || [];
  const latestCheckpoint = data?.lifecycle?.latestCheckpoint;
  const statusInfo =
    typeof data?.status === 'object' && data?.status !== null
      ? data.status
      : null;

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-7xl mx-auto">
      {/* Row 1: KPI Cards */}
      <KpiCards healthScore={healthScore} counts={mergedCounts} />

      {/* Row 2: 3 Interactive Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        <HealthGaugeCard
          score={healthScore}
          verified={mergedCounts.verifiedNotes ?? mergedCounts.activeNotes ?? 0}
          candidates={mergedCounts.unpromotedCandidates ?? 0}
          conflicts={(mergedCounts.conflictedNotes ?? 0) + duplicateGroupCount}
        />
        <DistributionCard byKind={analytics.byKind} />
        <ActivityCard activitySeries={analytics.activitySeries} />
      </div>

      {/* Row 3: Live AI Session Activity & Memory Map */}
      <SessionActivityMap sessions={sessions} />

      {/* Row 4: Causal Triads */}
      {data?.causalTriads && data.causalTriads.length > 0 && (
        <CausalTriadsCard causalTriads={data.causalTriads} />
      )}

      {/* Row 5: Recommendations + Sessions Table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6 items-start">
        <RecommendationsCard
          recommendations={audit?.recommendations}
          statusInfo={statusInfo}
          latestCheckpoint={latestCheckpoint}
        />
        <SessionsTable sessions={sessions} />
      </div>
    </div>
  );
}
