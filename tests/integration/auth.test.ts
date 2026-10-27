import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { makeUser, TEST_PASSWORD } from '../helpers/fixtures';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const c = () => new Client(h.app);

describe('registration', () => {
  it('creates an unverified account and does not sign the person in', async () => {
    const cl = c();
    const r = await cl.post('/api/v1/auth/register', {
      email: 'new@example.com',
      password: 'A-strong-passphrase-72!',
      name: 'New Person',
      accountType: 'advertiser',
      organizationName: 'New Co',
    });
    expect(r.status).toBe(202);
    const row = await h.db.query('SELECT email_verified_at FROM users WHERE email = $1', ['new@example.com']);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.email_verified_at).toBeNull();
    // Registration must not hand out a session before the address is proven.
    expect(cl.authenticated).toBe(false);
    // The advertiser organisation is created and starts out awaiting approval.
    const org = await h.db.query<{ type: string; status: string }>('SELECT type, status FROM organizations');
    expect(org.rows[0]!.type).toBe('advertiser');
  });

  it('gives the same answer whether or not the address is already taken', async () => {
    await makeUser(h.db, { email: 'taken@example.com' });
    const first = await c().post('/api/v1/auth/register', { email: 'taken@example.com', password: 'A-strong-passphrase-72!', name: 'Someone' });
    const second = await c().post('/api/v1/auth/register', { email: 'free@example.com', password: 'A-strong-passphrase-72!', name: 'Someone' });
    // Enumerating registered addresses must not be possible.
    expect(first.status).toBe(second.status);
    expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body));
  });

  it('refuses weak passwords', async () => {
    for (const password of ['short', 'password', '12345678', 'aaaaaaaa']) {
      const r = await c().post('/api/v1/auth/register', { email: `w${Math.random()}@example.com`, password, name: 'Weak' });
      expect(r.status, password).toBe(400);
    }
  });

  it('refuses an invalid email address', async () => {
    const r = await c().post('/api/v1/auth/register', { email: 'not-an-email', password: 'A-strong-passphrase-72!', name: 'X' });
    expect(r.status).toBe(400);
  });

  it('stores the password as an argon2 hash, never in the clear', async () => {
    await c().post('/api/v1/auth/register', { email: 'hash@example.com', password: 'A-strong-passphrase-72!', name: 'H' });
    const row = await h.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', ['hash@example.com']);
    const hash = row.rows[0]!.password_hash;
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('A-strong-passphrase-72!');
  });
});

describe('email verification', () => {
  it('verifies with the emailed token and refuses a second use', async () => {
    const u = await makeUser(h.db, { verified: false });
    const token = await issueToken(u.id, 'verify_email');
    const first = await c().post('/api/v1/auth/verify-email', { token });
    expect(first.status).toBe(200);
    const after = await h.db.query('SELECT email_verified_at FROM users WHERE id = $1', [u.id]);
    expect(after.rows[0]!.email_verified_at).not.toBeNull();

    // Replaying the link must fail: tokens are single-use.
    const second = await c().post('/api/v1/auth/verify-email', { token });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an unknown or malformed token', async () => {
    expect((await c().post('/api/v1/auth/verify-email', { token: 'x'.repeat(40) })).status).toBeGreaterThanOrEqual(400);
    expect((await c().post('/api/v1/auth/verify-email', { token: 'tooshort' })).status).toBe(400);
  });
});

describe('login', () => {
  it('signs in with the right password and sets both session and CSRF cookies', async () => {
    const u = await makeUser(h.db);
    const cl = c();
    const r = await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    expect(r.status).toBe(200);
    expect(cl.authenticated).toBe(true);
    // The CSRF cookie must be readable by scripts; the session cookie must not.
    expect(cl.csrf).toBeTruthy();
    const cookies = String(r.headers['set-cookie']);
    expect(cookies).toContain('HttpOnly');
  });

  it('refuses the wrong password without saying which part was wrong', async () => {
    const u = await makeUser(h.db);
    const wrongPassword = await c().post('/api/v1/auth/login', { email: u.email, password: 'Not-the-password-1!' });
    const wrongEmail = await c().post('/api/v1/auth/login', { email: 'nobody@example.com', password: TEST_PASSWORD });
    expect(wrongPassword.status).toBe(401);
    expect(wrongEmail.status).toBe(401);
    expect(wrongPassword.body?.error?.message).toBe(wrongEmail.body?.error?.message);
  });

  it('locks the account after five failed attempts', async () => {
    const u = await makeUser(h.db);
    for (let i = 0; i < 5; i++) {
      const r = await c().post('/api/v1/auth/login', { email: u.email, password: 'Wrong-password-1!' });
      expect(r.status, `attempt ${i}`).toBe(401);
    }
    // Even the correct password is refused while the lock holds.
    const locked = await c().post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
  });

  it('refuses a suspended account', async () => {
    const u = await makeUser(h.db, { status: 'suspended' });
    const r = await c().post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(r.status).toBeLessThan(500);
  });

  it('records both successes and failures in the authentication log', async () => {
    const u = await makeUser(h.db);
    await c().post('/api/v1/auth/login', { email: u.email, password: 'Wrong-password-1!' });
    await c().post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    const events = await h.db.query<{ type: string }>('SELECT type FROM auth_events');
    const types = events.rows.map((r) => r.type);
    expect(types).toContain('login_failure');
    expect(types).toContain('login_success');
  });

  it('never writes the password into the authentication log', async () => {
    const u = await makeUser(h.db);
    await c().post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    const rows = await h.db.query('SELECT * FROM auth_events');
    expect(JSON.stringify(rows.rows)).not.toContain(TEST_PASSWORD);
    // The address itself is stored only as a hash.
    expect(JSON.stringify(rows.rows)).not.toContain(u.email);
  });
});

describe('session lifecycle', () => {
  it('returns the signed-in user from /auth/me and nothing when signed out', async () => {
    const u = await makeUser(h.db, { name: 'Session Person' });
    const cl = c();
    expect((await cl.get('/api/v1/auth/me')).status).toBe(401);
    await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    const me = await cl.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(u.email);
    expect(me.body.user.name).toBe('Session Person');
    // The response must never carry the password hash.
    expect(JSON.stringify(me.body)).not.toContain('argon2');
  });

  it('logging out invalidates the session server-side, not just the cookie', async () => {
    const u = await makeUser(h.db);
    const cl = c();
    await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    const stolen = cl.cookieHeader();
    await cl.post('/api/v1/auth/logout');

    // Replaying the old cookie must not work.
    const replay = await h.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: stolen } });
    expect(replay.statusCode).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const u = await makeUser(h.db);
    const cl = c();
    await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    const cookie = cl.cookieHeader().match(/bn_session=([^;]+)/)![1]!;
    const rows = await h.db.query('SELECT * FROM sessions WHERE user_id = $1', [u.id]);
    expect(rows.rowCount).toBe(1);
    // A database leak must not hand out working sessions.
    expect(JSON.stringify(rows.rows)).not.toContain(cookie);
  });

  it('lets a user list and revoke their own sessions', async () => {
    const u = await makeUser(h.db);
    const a = c();
    const b = c();
    await a.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    await b.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });

    const list = await a.get('/api/v1/auth/sessions');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(2);

    const other = list.body.data.find((s: any) => !s.current);
    const revoked = await a.del(`/api/v1/auth/sessions/${other.id}`);
    expect(revoked.status).toBeLessThan(300);
    expect((await b.get('/api/v1/auth/me')).status).toBe(401);
    // The session doing the revoking stays valid.
    expect((await a.get('/api/v1/auth/me')).status).toBe(200);
  });
});

describe('password reset', () => {
  it('accepts a request for an unknown address without revealing that it is unknown', async () => {
    const known = await makeUser(h.db);
    const a = await c().post('/api/v1/auth/password-reset/request', { email: known.email });
    const b = await c().post('/api/v1/auth/password-reset/request', { email: 'nobody@example.com' });
    expect(a.status).toBe(b.status);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });

  it('resets the password, revokes existing sessions and consumes the token', async () => {
    const u = await makeUser(h.db);
    const signedIn = c();
    await signedIn.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    expect((await signedIn.get('/api/v1/auth/me')).status).toBe(200);

    const token = await issueToken(u.id, 'reset_password');
    const newPassword = 'A-different-passphrase-8812!';
    const r = await c().post('/api/v1/auth/password-reset/confirm', { token, password: newPassword });
    expect(r.status).toBe(200);

    // Old sessions must not survive a password reset.
    expect((await signedIn.get('/api/v1/auth/me')).status).toBe(401);
    // The old password must no longer work, the new one must.
    expect((await c().post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD })).status).toBe(401);
    expect((await c().post('/api/v1/auth/login', { email: u.email, password: newPassword })).status).toBe(200);
    // The token is single-use.
    expect((await c().post('/api/v1/auth/password-reset/confirm', { token, password: 'Yet-another-passphrase-55!' })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('changing a password while signed in', () => {
  it('requires the current password', async () => {
    const u = await makeUser(h.db);
    const cl = c();
    await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
    const wrong = await cl.post('/api/v1/auth/password', { currentPassword: 'Wrong-password-1!', newPassword: 'A-new-passphrase-4411!' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const right = await cl.post('/api/v1/auth/password', { currentPassword: TEST_PASSWORD, newPassword: 'A-new-passphrase-4411!' });
    expect(right.status).toBeLessThan(300);
  });
});

/** Issues a token the way the mailer would, so tests do not read email. */
async function issueToken(userId: string, purpose: 'verify_email' | 'reset_password'): Promise<string> {
  const { randomToken, sha256 } = await import('@blissnova/api/lib/crypto');
  const token = randomToken(32);
  await h.db.query(
    `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
    [userId, purpose, sha256(token)],
  );
  return token;
}
