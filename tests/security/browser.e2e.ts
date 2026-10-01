import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { prisma } from '../../src/lib/prisma';

const base = process.env.BASE_URL!;
if (new URL(base).hostname !== '127.0.0.1' || new URL(process.env.DATABASE_URL!).pathname !== '/wa_akg_security') throw new Error('Dedicated disposable gateway required');

test('Chromium sign-in, internal redirects and API key rotation guards', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const user = await prisma.user.findUniqueOrThrow({ where: { email: process.env.ADMIN_EMAIL! } });
  let posts = 0;
  try {
    await page.goto(base + '/auth/login?callbackUrl=https%3A%2F%2Fexternal.example.invalid');
    await page.getByLabel('Email', { exact: true }).fill(process.env.ADMIN_EMAIL!);
    await page.getByLabel('Password', { exact: true }).fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /Sign In/i }).click();
    await page.waitForURL(base + '/dashboard');
    assert.equal(new URL(page.url()).origin, base);
    const generated = await context.request.post(base + '/api/user/api-key');
    assert.equal(generated.status(), 200);
    const keyHash = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).apiKey;
    await context.route('**/api/user/api-key', async route => {
      if (route.request().method() === 'POST') { posts++; await route.abort(); return; }
      await new Promise(resolve => setTimeout(resolve, 800));
      await route.continue();
    });
    await page.goto(base + '/dashboard/webhooks');
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
    const regen = page.getByRole('button', { name: 'Regenerate', exact: true });
    await expect(regen).toBeEnabled();
    await regen.click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(posts, 0, 'loading or cancellation must not rotate a configured key');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).apiKey, keyHash);
    await context.unroute('**/api/user/api-key');
    let fail = true;
    await context.route('**/api/user/api-key', async route => {
      if (route.request().method() === 'POST') { posts++; await route.abort(); return; }
      if (fail) await route.fulfill({ status: 503, body: '{}' });
      else await route.continue();
    });
    await page.reload();
    await expect(page.getByText('Could not load key state', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
    fail = false;
    await page.getByRole('button', { name: 'Retry loading key state', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Regenerate', exact: true })).toBeEnabled();
    assert.equal(posts, 0);
    await page.goto(base + '/swagger');
    await expect(page.locator('.swagger-ui')).toBeVisible();
    const anonymous = await browser.newContext();
    const response = await anonymous.request.get(base + '/api/docs');
    assert.equal(response.status(), 401);
    await anonymous.close();
    console.log('Chromium: real login + redirect guard + delayed/failed key lookup + rotation cancellation + retry + authenticated Swagger passed');
  } finally {
    await browser.close();
    await prisma.user.update({ where: { id: user.id }, data: { apiKey: user.apiKey } });
    await prisma.$disconnect();
  }
});
