import { describe, it, expect } from 'vitest';
import {
  healthTone,
  gaugePercents,
  kindDistribution,
} from './overview-math';

describe('overview-math', () => {
  describe('healthTone', () => {
    it('returns healthy for score >= 85', () => {
      const res85 = healthTone(85);
      expect(res85.tone).toBe('healthy');
      expect(res85.color).toBe('#10b981');
      expect(res85.label).toBe('สมบูรณ์ดีเยี่ยม (Healthy)');

      const res100 = healthTone(100);
      expect(res100.tone).toBe('healthy');
    });

    it('returns fair for score between 65 and 84', () => {
      const res65 = healthTone(65);
      expect(res65.tone).toBe('fair');
      expect(res65.color).toBe('#f59e0b');
      expect(res65.label).toBe('ควรตรวจสอบ (Fair)');

      const res84 = healthTone(84);
      expect(res84.tone).toBe('fair');
    });

    it('returns critical for score < 65', () => {
      const res64 = healthTone(64);
      expect(res64.tone).toBe('critical');
      expect(res64.color).toBe('#ef4444');
      expect(res64.label).toBe('ต้องแก้ไขด่วน (Action Needed)');

      const res0 = healthTone(0);
      expect(res0.tone).toBe('critical');
    });

    it('handles NaN and non-numeric inputs safely', () => {
      const resNaN = healthTone(NaN);
      expect(resNaN.tone).toBe('critical');
      expect(resNaN.label).toBe('ต้องแก้ไขด่วน (Action Needed)');
    });
  });

  describe('gaugePercents', () => {
    it('calculates integer percentages when total > 0', () => {
      expect(
        gaugePercents({ verified: 2, candidates: 2, conflicts: 0 }),
      ).toEqual({
        verified: 50,
        candidates: 50,
        conflicts: 0,
      });

      expect(
        gaugePercents({ verified: 1, candidates: 2, conflicts: 1 }),
      ).toEqual({
        verified: 25,
        candidates: 50,
        conflicts: 25,
      });
    });

    it('returns 0 for all when total is 0', () => {
      expect(
        gaugePercents({ verified: 0, candidates: 0, conflicts: 0 }),
      ).toEqual({
        verified: 0,
        candidates: 0,
        conflicts: 0,
      });
    });

    it('handles negative or invalid counts safely', () => {
      expect(
        gaugePercents({ verified: -1, candidates: 0, conflicts: 0 }),
      ).toEqual({
        verified: 0,
        candidates: 0,
        conflicts: 0,
      });
    });
  });

  describe('kindDistribution', () => {
    it('calculates counts and percents for byKind records', () => {
      const items = kindDistribution({ adr: 1, insight: 3 });
      expect(items).toHaveLength(4);

      const adr = items.find((i) => i.key === 'adr');
      const ins = items.find((i) => i.key === 'insight');
      const mis = items.find((i) => i.key === 'mistake');
      const ses = items.find((i) => i.key === 'session-log');

      expect(adr).toEqual(
        expect.objectContaining({ key: 'adr', count: 1, percent: 25 }),
      );
      expect(ins).toEqual(
        expect.objectContaining({ key: 'insight', count: 3, percent: 75 }),
      );
      expect(mis).toEqual(
        expect.objectContaining({ key: 'mistake', count: 0, percent: 0 }),
      );
      expect(ses).toEqual(
        expect.objectContaining({ key: 'session-log', count: 0, percent: 0 }),
      );
    });

    it('handles empty byKind or zero total without NaN', () => {
      const items = kindDistribution({});
      for (const it of items) {
        expect(it.count).toBe(0);
        expect(it.percent).toBe(0);
        expect(Number.isNaN(it.percent)).toBe(false);
      }
    });
  });
});
