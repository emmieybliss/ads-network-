import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { BillingError, LedgerError } from '@blissnova/billing';

export type ErrorCode =
  | 'bad_request' | 'validation_failed' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict'
  | 'rate_limited' | 'payload_too_large' | 'unsupported_media_type' | 'insufficient_funds' | 'step_up_required'
  | 'mfa_required' | 'maintenance' | 'service_unavailable' | 'internal_error';

export class AppError extends Error {
  constructor(public status: number, public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(400, 'bad_request', m, d);
export const unauthenticated = (m = 'Authentication required') => new AppError(401, 'unauthenticated', m);
export const forbidden = (m = 'You do not have permission to perform this action') => new AppError(403, 'forbidden', m);
/** Used for missing resources AND for resources owned by another organization, so existence is never leaked. */
export const notFound = (m = 'Resource not found') => new AppError(404, 'not_found', m);
export const conflict = (m: string, d?: unknown) => new AppError(409, 'conflict', m, d);
/** A payment or payout provider refused or could not be reached. */
export const providerError = (m: string) => new AppError(502, 'service_unavailable', m);

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  const requestId = req.id;
  if (err instanceof AppError) {
    return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId } });
  }
  if (err instanceof ZodError) {
    return reply.status(400).send({ error: { code: 'validation_failed', message: 'Request validation failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), requestId } });
  }
  if (err instanceof BillingError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'insufficient_funds' ? 402 : err.code === 'invalid' ? 400 : 409;
    return reply.status(status).send({ error: { code: err.code === 'insufficient_funds' ? 'insufficient_funds' : err.code === 'not_found' ? 'not_found' : err.code === 'invalid' ? 'bad_request' : 'conflict', message: err.message, requestId } });
  }
  if (err instanceof LedgerError) {
    req.log.error({ err }, 'ledger error');
    return reply.status(409).send({ error: { code: 'conflict', message: 'The financial operation could not be recorded', requestId } });
  }
  const fe = err as FastifyError;
  if (fe.validation) {
    return reply.status(400).send({ error: { code: 'validation_failed', message: fe.message, details: fe.validation, requestId } });
  }
  if (fe.statusCode === 413 || fe.code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply.status(413).send({ error: { code: 'payload_too_large', message: 'Payload too large', requestId } });
  }
  if (fe.statusCode === 415) return reply.status(415).send({ error: { code: 'unsupported_media_type', message: fe.message, requestId } });
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send({ error: { code: 'bad_request', message: fe.message, requestId } });
  }
  // Postgres constraint violations that escaped service-level checks.
  const pgCode = (err as { code?: string }).code;
  if (pgCode === '23505') return reply.status(409).send({ error: { code: 'conflict', message: 'A record with these details already exists', requestId } });
  if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23503') {
    req.log.warn({ err }, 'constraint violation');
    return reply.status(400).send({ error: { code: 'bad_request', message: 'The request violates a data constraint', requestId } });
  }
  req.log.error({ err }, 'unhandled error');
  req.server.reportError?.(err, req);
  return reply.status(500).send({ error: { code: 'internal_error', message: 'An unexpected error occurred', requestId } });
}
