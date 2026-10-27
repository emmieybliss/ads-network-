import type { NextConfig } from 'next';

/**
 * The browser talks to the web app's own origin; /api/v1, /sdk and /assets are
 * proxied to the API server. Session cookies are therefore first-party, and
 * the same layout works behind a single production hostname.
 *
 * API_INTERNAL_URL is where this server reaches the API (default: local dev).
 * Nothing here hardcodes a production domain.
 */
const api = (process.env.API_INTERNAL_URL || 'http://localhost:4000').replace(/\/$/, '');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
];

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@blissnova/shared'],
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` },
      { source: '/sdk/:path*', destination: `${api}/sdk/:path*` },
      { source: '/assets/:path*', destination: `${api}/assets/:path*` },
      { source: '/docs/api', destination: `${api}/docs` },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
