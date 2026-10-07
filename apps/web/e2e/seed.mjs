import argon2 from 'argon2';
import pg from 'pg';

const email='e2e@clouddeck.local';
const password='CloudDeck-E2E-Password-2026!';
const client=new pg.Client({connectionString:process.env.DATABASE_URL});

await client.connect();
try{
  await client.query('BEGIN');
  const hash=await argon2.hash(password,{type:argon2.argon2id});
  const user=await client.query(
    `INSERT INTO users(email,password_hash,email_verified_at)
     VALUES($1,$2,now())
     ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,email_verified_at=now()
     RETURNING id`,
    [email,hash]
  );
  const userId=user.rows[0].id;
  const existing=await client.query(
    `SELECT o.id
     FROM organizations o
     JOIN organization_members m ON m.organization_id=o.id
     WHERE m.user_id=$1
     ORDER BY o.created_at ASC
     LIMIT 1`,
    [userId]
  );
  if(!existing.rowCount){
    const org=await client.query(
      `INSERT INTO organizations(name,personal) VALUES('E2E Workspace',true) RETURNING id`
    );
    await client.query(
      `INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')`,
      [org.rows[0].id,userId]
    );
  }
  await client.query('COMMIT');
  console.log(`Seeded ${email}`);
}catch(error){
  await client.query('ROLLBACK');
  throw error;
}finally{
  await client.end();
}
