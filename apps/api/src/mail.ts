import nodemailer from 'nodemailer';
export async function sendChallenge(kind:'verify_email'|'reset_password',email:string,token:string) {
  if (process.env.NODE_ENV==='test') return;
  const host=process.env.SMTP_HOST;
  if (!host) throw new Error('SMTP_HOST is required for account emails');
  const transport=nodemailer.createTransport({host,port:Number(process.env.SMTP_PORT??587),secure:process.env.SMTP_SECURE==='true',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined});
  const origin=process.env.APP_ORIGIN??'http://localhost:3000';
  const subject=kind==='verify_email'?'Verify your CloudDeck email':'Reset your CloudDeck password';
  const path=kind==='verify_email'?'verify':'reset-password';
  const link=`${origin}/${path}?token=${encodeURIComponent(token)}`;
  await transport.sendMail({from:process.env.MAIL_FROM??'CloudDeck <noreply@localhost>',to:email,subject,text:`${subject}\n\nOpen this link within 30 minutes:\n${link}\n\nIf you did not request this, ignore this message.`});
}
