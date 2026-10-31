import { z } from 'zod';

export const diaryDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
export const diaryTarget = z.object({ partnerId: z.string().min(1).max(200), date: diaryDate }).strict();
export const diaryConfigure = z.object({ partnerId: z.string().min(1).max(200), enabled: z.boolean(), conversationId: z.string().min(1).max(256),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u), acknowledgeUpstreamHistory: z.boolean().optional() }).strict();
export interface PartnerDiaryConfig {
  partnerId: string; enabled: boolean; conversationId: string; time: string; revision: number;
  upstreamThreadId?: string; disabledReason?: 'source_deleted';
}
export type DiaryState = 'running' | 'completed' | 'skipped' | 'failed';
export interface PartnerDiaryEntry {
  partnerId: string; date: string; generationId: string; conversationId: string; state: DiaryState;
  attemptedAt: string; finishedAt?: string; reason?: string; contentHash?: string;
}
export interface PartnerDiaryDocument { entry: PartnerDiaryEntry; content?: string; }
export interface PartnerDiarySnapshot { configs: PartnerDiaryConfig[]; entries: PartnerDiaryEntry[]; notices?: Record<string, string>; }
export interface AsteriumPartnerDiaryApi {
  get: () => Promise<PartnerDiarySnapshot>;
  configure: (input: z.infer<typeof diaryConfigure>) => Promise<PartnerDiaryConfig>;
  read: (input: z.infer<typeof diaryTarget>) => Promise<PartnerDiaryDocument | undefined>;
  exportMarkdown: (input: z.infer<typeof diaryTarget>) => Promise<boolean>;
}
export function diaryLogicalDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
