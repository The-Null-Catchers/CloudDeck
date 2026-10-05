import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import type { FastifyError } from 'fastify';
import { authRoutes } from './auth.js';
import { serverRoutes } from './servers.js';
import { agentRoutes } from './agent.js';
import {dockerRoutes} from './docker.js';
import {serviceRoutes} from './services.js';
import {logRoutes} from './logs.js';
import {streamRoutes} from './streams.js';
import {terminalRoutes} from './terminal.js';
import {deploymentRoutes} from './deployments.js';
import {deploymentLogRoutes} from './deployment-logs.js';
import {githubRoutes} from './github.js';
import {githubWebhookRoutes} from './github-webhook.js';
import {applicationRoutes} from './applications.js';
import {healthCheckRoutes} from './health-checks.js';
import {alertRoutes} from './alerts.js';
import {domainRoutes} from './domains.js';
import {secretRoutes} from './secrets.js';
import {backupRoutes} from './backups.js';
import {twoFactorRoutes} from './two-factor.js';
import {pushDeviceRoutes} from './push-devices.js';
import {demoRoutes} from './demo.js';
import {startBackupRunner} from './backup-runner.js';
import {startDomainTlsRunner} from './domain-runner.js';
import {startHealthCheckRunner} from './health-runner.js';
import {startDeploymentQueueReconciler,closeDeploymentQueue} from './deployment-queue.js';
import {startDeploymentWorker,closeDeploymentWorker} from './deployment-worker.js';
import {startNotificationQueueReconciler,closeNotificationQueue} from './notification-queue.js';
import {startNotificationWorker,closeNotificationWorker} from './notification-worker.js';
import {closeAgentRouter} from './commands.js';
import {startRealtimeRouter,closeRealtimeRouter} from './realtime-router.js';
import './security.js';
import { startOfflineSweep } from './offline.js';
import {startMetricRollupRunner} from './metrics-retention.js';

export function buildApp() {
  const app = Fastify({logger:{redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','body.password','body.token','body.credential','body.value']},bodyLimit:65536,trustProxy:false});
  app.register(cors,{origin:process.env.APP_ORIGIN ?? 'http://localhost:3000',credentials:true});
  app.register(cookie);
  app.register(rateLimit,{max:100,timeWindow:'1 minute'});
  app.register(websocket);
  app.addHook('onRequest',async (request,reply) => {
    if (!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.origin && request.headers.origin !== (process.env.APP_ORIGIN ?? 'http://localhost:3000')) {
      reply.code(403).send({error:{code:'ORIGIN_DENIED',message:'Origin denied'}});
    }
  });
  app.setErrorHandler((error: FastifyError,request,reply) => {
    const status = error instanceof ZodError ? 400 : ('statusCode' in error && typeof error.statusCode==='number' ? error.statusCode : 500);
    if (status>=500) request.log.error(error);
    reply.code(status).send({error:{code: status===400?'VALIDATION_ERROR':status===401?'UNAUTHORIZED':status===403?'FORBIDDEN':status===404?'NOT_FOUND':status===409?'CONFLICT':status===502?'UPSTREAM_ERROR':status===503?'AGENT_UNAVAILABLE':status===504?'AGENT_TIMEOUT':'INTERNAL_ERROR',message:status>=500?'Internal server error':error.message}});
  });
  app.get('/health',async () => ({status:'ok'}));
  app.register(authRoutes,{prefix:'/api/v1/auth'});
  app.register(serverRoutes,{prefix:'/api/v1'});
  app.register(agentRoutes,{prefix:'/api/v1/agent'});
  app.register(dockerRoutes,{prefix:'/api/v1'});
  app.register(serviceRoutes,{prefix:'/api/v1'});
  app.register(logRoutes,{prefix:'/api/v1'});
  app.register(streamRoutes,{prefix:'/api/v1'});
  app.register(terminalRoutes,{prefix:'/api/v1'});
  app.register(deploymentRoutes,{prefix:'/api/v1'});
  app.register(deploymentLogRoutes,{prefix:'/api/v1'});
  app.register(githubRoutes,{prefix:'/api/v1'});
  app.register(githubWebhookRoutes,{prefix:'/api/v1/webhooks'});
  app.register(applicationRoutes,{prefix:'/api/v1'});
  app.register(healthCheckRoutes,{prefix:'/api/v1'});
  app.register(alertRoutes,{prefix:'/api/v1'});
  app.register(domainRoutes,{prefix:'/api/v1'});
  app.register(secretRoutes,{prefix:'/api/v1'});
  app.register(backupRoutes,{prefix:'/api/v1'});
  app.register(twoFactorRoutes,{prefix:'/api/v1'});
  app.register(pushDeviceRoutes,{prefix:'/api/v1'});
  app.register(demoRoutes,{prefix:'/api/v1'});
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app=buildApp();
  await app.listen({host:'0.0.0.0',port:Number(process.env.PORT ?? 4000)});
  startRealtimeRouter();
  const stopSweep=startOfflineSweep();
  const stopDeploymentQueueReconciler=startDeploymentQueueReconciler();
  startDeploymentWorker();
  const stopHealthCheckRunner=startHealthCheckRunner();
  const stopDomainTlsRunner=startDomainTlsRunner();
  const stopNotificationQueueReconciler=startNotificationQueueReconciler();
  startNotificationWorker();
  const stopBackupRunner=startBackupRunner();
  const stopMetricRollupRunner=startMetricRollupRunner();
  app.addHook('onClose',async()=>{
    stopSweep();
    stopDeploymentQueueReconciler();
    stopHealthCheckRunner();
    stopDomainTlsRunner();
    stopNotificationQueueReconciler();
    stopBackupRunner();
    stopMetricRollupRunner();
    await closeRealtimeRouter();
    await closeAgentRouter();
    await closeNotificationWorker();
    await closeNotificationQueue();
    await closeDeploymentWorker();
    await closeDeploymentQueue();
  });
}
