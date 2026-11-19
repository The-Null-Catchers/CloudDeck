/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const {test,expect}=require('@playwright/test');

const baseURL='http://127.0.0.1:3000';
const email='e2e@clouddeck.local';
const password='CloudDeck-E2E-Password-2026!';

test('operator can sign in, open the server fleet, and create a pairing token',async({page})=>{
  await page.goto(`${baseURL}/login`);
  await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();

  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await Promise.all([
    page.waitForURL('**/dashboard'),
    page.getByRole('button',{name:/Sign in/}).click()
  ]);

  await expect(page.getByRole('heading',{name:'Infrastructure overview'})).toBeVisible();
  await expect(page.getByText('E2E Workspace',{exact:true})).toBeVisible();

  await page.getByRole('button',{name:'Servers',exact:true}).click();
  await expect(page).toHaveURL(/\/servers$/);
  await expect(page.getByRole('heading',{name:'Fleet inventory and health'})).toBeVisible();

  page.once('dialog',dialog=>dialog.accept('E2E Server'));
  await page.getByRole('button',{name:/Add server/}).click();

  await expect(page.getByText('Pairing token — shown once, expires in 10 minutes')).toBeVisible();
  await expect(page.getByRole('heading',{name:'E2E Server'})).toBeVisible();
  await expect(page.getByText('Awaiting agent pairing',{exact:true})).toBeVisible();
});

test('invalid password stays on the login screen and surfaces the auth error',async({page})=>{
  await page.goto(`${baseURL}/login`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill('Definitely-Wrong-Password!');
  await page.getByRole('button',{name:/Sign in/}).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('Invalid credentials',{exact:true})).toBeVisible();
});

test('fleet hides server creation when the workspace role is viewer',async({page})=>{
  // Override the displayed role only. The API still authenticates the seeded account.
  await page.route('**/api/v1/organizations',async route=>{
    const response=await route.fetch();
    const body=await response.json();
    await route.fulfill({
      response,
      json:{...body,organizations:body.organizations.map(org=>({...org,role:'viewer'}))}
    });
  });

  await page.goto(`${baseURL}/login`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button',{name:/Sign in/}).click();
  await expect(page).toHaveURL('**/dashboard');
  await page.getByRole('button',{name:'Servers',exact:true}).click();

  await expect(page.getByText('E2E Workspace · Servers',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Server fleet'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add server'})).toHaveCount(0);
});
