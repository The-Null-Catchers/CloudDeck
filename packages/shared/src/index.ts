export const roles = ['owner', 'admin', 'operator', 'viewer'] as const;
export type Role = typeof roles[number];
export const allowedActions = ['metrics.get', 'docker.listContainers', 'docker.restartContainer', 'systemd.restartService', 'logs.subscribe'] as const;
export type AgentAction = typeof allowedActions[number];
export interface ApiError { error: { code: string; message: string } }
export interface ServerSummary { id: string; name: string; hostname: string | null; status: 'online' | 'offline' | 'pending'; lastSeenAt: string | null; cpuPercent: number | null; memoryPercent: number | null; diskPercent: number | null }
