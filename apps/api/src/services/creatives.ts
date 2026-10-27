import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';
import type { PlatformSettings } from '@blissnova/shared';
import { AppError, badRequest } from '../lib/errors';

const MAGIC: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a' },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
];

/** Validate an uploaded image by content (never by client-supplied name or MIME type). SVG is not accepted because it can carry script. */
export function inspectImage(buf: Buffer, s: PlatformSettings) {
  if (buf.length === 0) throw badRequest('The file is empty');
  if (buf.length > s.creatives.maxUploadBytes) throw new AppError(413, 'payload_too_large', `Images must be ${Math.round(s.creatives.maxUploadBytes / 1000)} KB or smaller`);
  const kind = MAGIC.find((m) => m.test(buf));
  if (!kind || !s.creatives.allowedImageTypes.includes(kind.mime as never)) throw new AppError(415, 'unsupported_media_type', `Allowed image types: ${s.creatives.allowedImageTypes.join(', ')}`);
  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(buf);
  } catch {
    throw badRequest('The image could not be read');
  }
  if (!dims.width || !dims.height) throw badRequest('The image dimensions could not be determined');
  if (dims.width > 2000 || dims.height > 2000 || dims.width < 10 || dims.height < 10) throw badRequest('Images must be between 10 and 2000 pixels in each dimension');
  const sha = createHash('sha256').update(buf).digest('hex');
  return { mime: kind.mime, ext: kind.ext, width: dims.width, height: dims.height, sha256: sha, size: buf.length };
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

/** Destination URLs are validated server-side: protocol allowlist, no embedded credentials, no private hosts, no blocked domains. */
export function validateDestinationUrl(raw: string, s: PlatformSettings, blockedDomains: string[], allowPrivate = false): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw badRequest('Destination URL is not a valid URL');
  }
  if (!s.creatives.allowedDestinationProtocols.includes(u.protocol as never)) throw badRequest(`Destination URL must use ${s.creatives.allowedDestinationProtocols.join(' or ')}`);
  if (u.username || u.password) throw badRequest('Destination URL must not contain credentials');
  if (!allowPrivate && (PRIVATE_HOST.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname))) throw badRequest('Destination URL must use a public domain name');
  if (!u.hostname.includes('.') && !allowPrivate) throw badRequest('Destination URL must use a fully qualified domain');
  const host = u.hostname.toLowerCase();
  if (blockedDomains.some((d) => host === d || host.endsWith(`.${d}`))) throw badRequest('Destination domain is not allowed on this network');
  if (u.href.length > 2048) throw badRequest('Destination URL is too long');
  return u.href;
}

export function serializeCreative(c: Record<string, any>, assetUrl: string | null) {
  return {
    id: c.id, campaignId: c.campaign_id, name: c.name, format: c.format, status: c.status, version: c.version, approvedVersion: c.approved_version,
    headline: c.headline, body: c.body, cta: c.cta, assetId: c.asset_id, imageUrl: assetUrl, width: c.width, height: c.height,
    destinationUrl: c.destination_url, displayUrl: c.display_url, altText: c.alt_text, rejectionReason: c.rejection_reason,
    createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

export function creativeSnapshot(c: Record<string, any>, storageKey: string | null) {
  return { name: c.name, format: c.format, headline: c.headline, body: c.body, cta: c.cta, assetId: c.asset_id, storageKey, width: c.width, height: c.height, destinationUrl: c.destination_url, displayUrl: c.display_url, altText: c.alt_text };
}
