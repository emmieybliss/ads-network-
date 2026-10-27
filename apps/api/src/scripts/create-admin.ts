/**
 * Create (or promote) the initial super administrator.
 *   pnpm admin:create -- --email admin@example.com --name "Ada Admin"
 * The password is read from ADMIN_PASSWORD or prompted on the terminal; it is never accepted as a CLI argument
 * (which would leak into shell history and process listings).
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPool } from '@blissnova/database';
import { hashPassword } from '../lib/crypto';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const email = arg('email')?.toLowerCase();
const name = arg('name') ?? 'Platform Administrator';
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: pnpm admin:create -- --email you@example.com [--name "Your Name"]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
let password = process.env.ADMIN_PASSWORD;
if (!password) {
  const rl = createInterface({ input: stdin, output: stdout });
  password = await rl.question('Password (min 12 chars): ');
  rl.close();
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters');
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_URL, 2);
try {
  const hash = await hashPassword(password);
  const r = await pool.query(
    `INSERT INTO users (email, name, password_hash, platform_role, email_verified_at) VALUES ($1, $2, $3, 'super_admin', now())
     ON CONFLICT (email) DO UPDATE SET platform_role = 'super_admin', status = 'active' RETURNING id, (xmax = 0) AS created`,
    [email, name, hash]);
  await pool.query(`INSERT INTO audit_logs (actor_type, action, resource_type, resource_id, after, reason) VALUES ('system', 'user.bootstrap_super_admin', 'user', $1, $2, 'Created via create-admin CLI')`, [r.rows[0].id, JSON.stringify({ email })]);
  console.log(r.rows[0].created ? `Created super administrator ${email}` : `Promoted existing user ${email} to super administrator (password unchanged)`);
  console.log('Enable MFA for this account from Settings > Security after signing in.');
} finally {
  await pool.end();
}
