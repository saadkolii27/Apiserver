export const PLAN_LIMITS = {
  free: {
    maxMonitors: 3,
    maxSnapshotsPerMonitor: 20,
    allowedFrequencies: ["15min", "30min", "hourly", "5h", "daily"] as string[],
    features: {
      visualDiff: false,
      actionReplay: false,
      liveBrowser: false,
    },
  },
  pro: {
    maxMonitors: 20,
    maxSnapshotsPerMonitor: 200,
    allowedFrequencies: ["30s", "1min", "5min", "15min", "30min", "hourly", "5h", "daily"] as string[],
    features: {
      visualDiff: true,
      actionReplay: true,
      liveBrowser: true,
    },
  },
} as const;

export type PlanType = keyof typeof PLAN_LIMITS;

export function getPlanLimits(plan: string) {
  return PLAN_LIMITS[plan as PlanType] ?? PLAN_LIMITS.free;
}
