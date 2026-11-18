import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_SEED_BODIES, STARTER_CONTENT } from '@blissnova/shared';
import { createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { makeUser, setSettings, TEST_PASSWORD } from '../helpers/fixtures';

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await h.reset(); });

async function admin() {
  const u = await makeUser(h.db, { platformRole: 'super_admin' });
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  await cl.post('/api/v1/auth/step-up', { password: TEST_PASSWORD });
  return cl;
}

describe('starter legal pages, policies and FAQs', () => {
  it('installs every draft once, replaces untouched placeholders and keeps edited items', async () => {
    await h.db.query(`INSERT INTO content_items (kind, slug, title, body, published) VALUES ('legal', 'terms', 'Terms of service', $1, false), ('legal', 'privacy', 'Privacy', 'Our own text', true)`, [LEGACY_SEED_BODIES[0]]);
    const cl = await admin();
    const before = await cl.get('/api/v1/admin/content');
    expect(before.body.starterMissing).toBe(STARTER_CONTENT.length - 2);
    expect(before.body.missingDetails.map((d: { key: string }) => d.key)).toContain('companyAddress');

    const r = await cl.post('/api/v1/admin/content/starter', { publish: true });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ added: STARTER_CONTENT.length - 2, replaced: 1, skipped: 1 });
    const rows = (await h.db.query(`SELECT slug, body, published FROM content_items WHERE kind = 'legal' ORDER BY slug`)).rows;
    expect(rows.find((x) => x.slug === 'privacy').body).toBe('Our own text');
    expect(rows.find((x) => x.slug === 'terms').body).toContain('# 1. Accounts');
    expect(rows.find((x) => x.slug === 'terms').published).toBe(true);

    const again = await cl.post('/api/v1/admin/content/starter', { publish: true });
    expect(again.body.data.added + again.body.data.replaced).toBe(0);
    expect((await cl.get('/api/v1/admin/content')).body.starterMissing).toBe(0);
  });

  it('serves documents with company details filled in, and gaps marked', async () => {
    const cl = await admin();
    await cl.post('/api/v1/admin/content/starter', { publish: true });
    await setSettings(h.db, 'branding', { companyAddress: '12 Marina Road, Lagos', supportEmail: 'help@blissnova.test' });
    h.app.ctx.settings.invalidate();
    const pub = await new Client(h.app).get('/api/v1/public/content?kind=legal');
    const terms = pub.body.data.find((d: { slug: string }) => d.slug === 'terms');
    expect(terms.body).toContain('registered office at 12 Marina Road, Lagos');
    expect(terms.body).toContain('[[Governing law]]');
    expect(terms.body).toContain('help@blissnova.test');
    expect(terms.body).not.toMatch(/\{\{/);
    const faq = (await new Client(h.app).get('/api/v1/public/content?kind=faq')).body.data;
    expect(faq[0].title).toBe('What is BlissNova Ad Network?');
  });

  it('only content managers can install drafts', async () => {
    const u = await makeUser(h.db);
    const cl = new Client(h.app);
    await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    expect((await cl.post('/api/v1/admin/content/starter', { publish: true })).status).toBe(403);
  });
});
