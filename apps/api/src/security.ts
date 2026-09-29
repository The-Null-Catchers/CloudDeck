import { randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import { pool } from './db.js';
export const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? '');
if (secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 bytes');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export async function accessToken(userId: string, sessionId: string) {
  return new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer('clouddeck').setAudience('clouddeck-api').setIssuedAt().setExpirationTime('10m').sign(secret);
}
export async function authenticate(request: FastifyRequest) {
  const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token) throw Object.assign(new Error('Authentication required'), {statusCode: 401});
  try {
    const { payload } = await jwtVerify(token, secret, {issuer: 'clouddeck', audience: 'clouddeck-api', algorithms: ['HS256']});
    const result = await pool.query('SELECT user_id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at > now()', [payload.sid, payload.sub]);
    if (!result.rowCount) throw new Error('revoked');
    return {userId: payload.sub!, sessionId: payload.sid as string};
  } catch { throw Object.assign(new Error('Invalid or revoked session'), {statusCode: 401}); }
}
export const permissions = {
  viewer: new Set(['server.read', 'metrics.read', 'audit.read']),
  operator: new Set(['server.read', 'metrics.read', 'audit.read', 'server.action', 'terminal.access']),
  admin: new Set(['server.read', 'metrics.read', 'audit.read', 'server.action', 'server.create', 'member.manage', 'terminal.access']),
  owner: new Set(['server.read', 'metrics.read', 'audit.read', 'server.action', 'server.create', 'member.manage', 'org.delete', 'terminal.access'])
} as const;
export function can(role: keyof typeof permissions, permission: string) { return permissions[role].has(permission); }
export async function membership(userId: string, orgId: string, permission: string) {
  const result = await pool.query('SELECT role FROM organization_members WHERE user_id=$1 AND organization_id=$2', [userId, orgId]);
  const role = result.rows[0]?.role as keyof typeof permissions | undefined;
  if (!role || !can(role, permission)) throw Object.assign(new Error('Access denied'), {statusCode: 403});
  return role;
}
export async function audit(orgId: string | null, actorId: string | null, action: string, resourceType: string, resourceId: string | null, ip: string, metadata: object = {}) {
  await pool.query('INSERT INTO audit_logs(organization_id,actor_id,action,resource_type,resource_id,ip,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)', [orgId,actorId,action,resourceType,resourceId,ip,JSON.stringify(metadata)]);
}
