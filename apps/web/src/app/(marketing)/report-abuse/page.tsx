import type { Metadata } from 'next';
import { ReportForm } from './ReportForm';

export const metadata: Metadata = { title: 'Report an ad or site' };

export default function ReportAbusePage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-20 sm:px-6">
      <h1 className="text-4xl font-semibold tracking-tight">Report an ad or a site</h1>
      <p className="mt-3 text-muted">Tell us about an advertisement or a publisher site that breaks our policies. Reports are reviewed by the trust and safety team.</p>
      <ReportForm />
    </div>
  );
}
