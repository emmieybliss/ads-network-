import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth';
import { orgRoutes } from './orgs';
import { advertiserRoutes } from './advertiser';
import { publisherRoutes } from './publisher';
import { reportRoutes } from './reports';
import { billingRoutes, webhookRoutes } from './billing';
import { serveRoutes, staticRoutes } from './serve';
import { publicRoutes } from './public';
import { integrationRoutes } from './integrations';
import { supportRoutes } from './support';
import { adminUserRoutes } from './admin/users';
import { adminOrgRoutes } from './admin/orgs';
import { adminInventoryRoutes } from './admin/inventory';
import { adminCampaignRoutes } from './admin/campaigns';
import { adminFinanceRoutes } from './admin/finance';
import { adminFraudRoutes } from './admin/fraud';
import { adminPlatformRoutes } from './admin/platform';
import { analyticsRoutes } from './analytics';
import { conversionRoutes } from './conversions';
import { partnerRoutes } from './partners';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(staticRoutes);
  await app.register(async (v1) => {
    for (const r of [authRoutes, orgRoutes, advertiserRoutes, publisherRoutes, reportRoutes, billingRoutes, serveRoutes, publicRoutes, integrationRoutes, supportRoutes,
      adminUserRoutes, adminOrgRoutes, adminInventoryRoutes, adminCampaignRoutes, adminFinanceRoutes, adminFraudRoutes, adminPlatformRoutes, partnerRoutes, analyticsRoutes, conversionRoutes]) {
      await v1.register(r);
    }
    await v1.register(webhookRoutes);
  }, { prefix: '/api/v1' });
}
