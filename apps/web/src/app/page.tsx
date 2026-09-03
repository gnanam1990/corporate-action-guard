/**
 * Foundation placeholder.
 *
 * Deliberately contains no asset list, metric, balance, health value, or transaction
 * hash. Runtime product data arrives from apps/api in modules 13 to 16 (ADR 0003).
 */
export default function HomePage() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

  return (
    <main id="main" style={{ padding: '3rem 1.5rem', maxWidth: '46rem' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.75rem' }}>Corporate Action Guard</h1>
      <p style={{ margin: '0 0 1.5rem', lineHeight: 1.6 }}>
        Operational console foundation. No product data is rendered yet; the design system and live
        evidence routes are built in later modules.
      </p>
      <p
        style={{
          margin: 0,
          fontFamily: 'Fira Code, ui-monospace, monospace',
          fontSize: '0.875rem',
        }}
      >
        API base URL: {apiBaseUrl}
      </p>
    </main>
  );
}
