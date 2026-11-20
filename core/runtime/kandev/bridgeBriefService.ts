/**
 * Daily brief data collection as a deterministic bridge service. It reuses the existing Personal Assistant brief projection
 * (tasks, approvals, reminders, schedules and results Core already recorded). No model, no research mission, no network:
 * a model is only used afterwards, optionally, to summarise this evidence.
 */
import { buildAssistantTodaySections } from '../../domain/assistantBrief';
import type { BridgeService } from './bridgeServices';

export function dailyBriefService(): BridgeService {
  return {
    id: 'brief.daily', label: 'Daily brief data (read-only, from Pandesh records)', readOnly: true, taskClasses: ['brief.daily'], roots: [],
    async run({ db }) {
      if (!db) throw new Error('the daily brief needs the Core database');
      const sections = buildAssistantTodaySections(db);
      const count = sections.reduce((n, s) => n + s.items.length, 0);
      return {
        summary: `${count} item${count === 1 ? '' : 's'} across ${sections.filter(s => s.available).length} section${sections.length === 1 ? '' : 's'}`,
        evidence: {
          kind: 'daily-brief', generatedAt: new Date().toISOString(), items: count,
          sections: sections.map(s => ({
            id: s.id, label: s.label, available: s.available, unavailableReason: s.unavailableReason, total: s.items.length,
            items: s.items.slice(0, 5).map(i => ({ title: i.title.slice(0, 100), state: i.state, at: i.at, source: i.source })),
          })),
        },
      };
    },
  };
}
