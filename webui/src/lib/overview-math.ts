export type HealthTone = 'healthy' | 'fair' | 'critical';
export type HealthColor = '#10b981' | '#f59e0b' | '#ef4444';

export interface HealthToneResult {
  tone: HealthTone;
  color: HealthColor;
  label: string;
}

export function healthTone(score: number): HealthToneResult {
  const num = Number(score);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    return {
      tone: 'critical',
      color: '#ef4444',
      label: 'ต้องแก้ไขด่วน (Action Needed)',
    };
  }

  if (num >= 85) {
    return {
      tone: 'healthy',
      color: '#10b981',
      label: 'สมบูรณ์ดีเยี่ยม (Healthy)',
    };
  }

  if (num >= 65) {
    return {
      tone: 'fair',
      color: '#f59e0b',
      label: 'ควรตรวจสอบ (Fair)',
    };
  }

  return {
    tone: 'critical',
    color: '#ef4444',
    label: 'ต้องแก้ไขด่วน (Action Needed)',
  };
}

export interface GaugePercentsInput {
  verified: number;
  candidates: number;
  conflicts: number;
}

export interface GaugePercentsResult {
  verified: number;
  candidates: number;
  conflicts: number;
}

export function gaugePercents(input: GaugePercentsInput): GaugePercentsResult {
  const verified = Math.max(0, Number(input?.verified) || 0);
  const candidates = Math.max(0, Number(input?.candidates) || 0);
  const conflicts = Math.max(0, Number(input?.conflicts) || 0);

  const total = verified + candidates + conflicts;
  if (total <= 0) {
    return {
      verified: 0,
      candidates: 0,
      conflicts: 0,
    };
  }

  return {
    verified: Math.round((verified / total) * 100),
    candidates: Math.round((candidates / total) * 100),
    conflicts: Math.round((conflicts / total) * 100),
  };
}

export type MemoryKindKey = 'adr' | 'insight' | 'mistake' | 'session-log';

export interface KindDistributionItem {
  key: MemoryKindKey;
  count: number;
  percent: number;
}

export function kindDistribution(
  byKind?: Record<string, number> | null,
): KindDistributionItem[] {
  const safe = byKind || {};
  const nAdr = Math.max(0, Number(safe['adr']) || 0);
  const nIns = Math.max(0, Number(safe['insight']) || 0);
  const nMis = Math.max(0, Number(safe['mistake']) || 0);
  const nSes = Math.max(0, Number(safe['session-log']) || 0);

  const total = nAdr + nIns + nMis + nSes;

  const toPercent = (count: number) =>
    total > 0 ? Math.round((count / total) * 100) : 0;

  return [
    { key: 'adr', count: nAdr, percent: toPercent(nAdr) },
    { key: 'insight', count: nIns, percent: toPercent(nIns) },
    { key: 'mistake', count: nMis, percent: toPercent(nMis) },
    { key: 'session-log', count: nSes, percent: toPercent(nSes) },
  ];
}

export function calculateGaugeDashOffset(score: number, radius = 58): { circumference: number; dashOffset: number } {
  const num = Math.min(100, Math.max(0, Number(score) || 0));
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (num / 100) * circumference;
  return { circumference, dashOffset };
}
