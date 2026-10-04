import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resetPushProviderCache,sendPushNotification} from '../src/push-provider.ts';

const validToken='test-registration-token-'.padEnd(40,'x');

test('push provider requires complete FCM service-account configuration',async()=>{
  const previous={
    projectId:process.env.FCM_PROJECT_ID,
    clientEmail:process.env.FCM_CLIENT_EMAIL,
    privateKey:process.env.FCM_PRIVATE_KEY
  };
  try{
    delete process.env.FCM_PROJECT_ID;
    delete process.env.FCM_CLIENT_EMAIL;
    delete process.env.FCM_PRIVATE_KEY;
    resetPushProviderCache();
    await assert.rejects(
      ()=>sendPushNotification({token:validToken,title:'Test',type:'info'}),
      /FCM push delivery is not configured/
    );

    process.env.FCM_PROJECT_ID='clouddeck-test';
    await assert.rejects(
      ()=>sendPushNotification({token:validToken,title:'Test',type:'info'}),
      /must be configured together/
    );
  }finally{
    if(previous.projectId===undefined)delete process.env.FCM_PROJECT_ID;else process.env.FCM_PROJECT_ID=previous.projectId;
    if(previous.clientEmail===undefined)delete process.env.FCM_CLIENT_EMAIL;else process.env.FCM_CLIENT_EMAIL=previous.clientEmail;
    if(previous.privateKey===undefined)delete process.env.FCM_PRIVATE_KEY;else process.env.FCM_PRIVATE_KEY=previous.privateKey;
    resetPushProviderCache();
  }
});

test('push provider rejects malformed registration tokens before network access',async()=>{
  await assert.rejects(
    ()=>sendPushNotification({token:'short',title:'Test',type:'info'}),
    /Invalid push token/
  );
});
