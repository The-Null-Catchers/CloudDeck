export const roles = ['owner', 'admin', 'operator', 'viewer'] as const;
export type Role = typeof roles[number];
export const allowedActions = [
  'docker.listContainers',
  'docker.startContainer',
  'docker.stopContainer',
  'docker.restartContainer',
  'docker.pauseContainer',
  'docker.unpauseContainer',
  'docker.removeContainer',
  'docker.listComposeProjects',
  'docker.startComposeService',
  'docker.stopComposeService',
  'docker.restartComposeService',
  'docker.inspectContainer',
  'docker.getContainerStats',
  'docker.tailContainerLogs',
  'systemd.listServices',
  'systemd.startService',
  'systemd.stopService',
  'systemd.restartService',
  'systemd.tailLogs',
  'deployment.execute',
  'deployment.rollback',
  'deployment.rollbackCompose',
  'deployment.cancel',
  'backup.execute'
] as const;
export type AgentAction = typeof allowedActions[number];
export interface ApiError { error: { code: string; message: string } }
export interface ServerSummary { id: string; name: string; hostname: string | null; status: 'online' | 'offline' | 'pending'; lastSeenAt: string | null; cpuPercent: number | null; memoryPercent: number | null; diskPercent: number | null }
