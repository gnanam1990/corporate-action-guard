/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The console is a thin client over apps/api. It never imports a server package and
  // never reads a server secret. API_INTERNAL_BASE_URL stays server-side; only
  // NEXT_PUBLIC_API_BASE_URL may reach the browser.
  env: {},
  typedRoutes: true,
  // Emit the dependency-traced production server so the runtime image contains only
  // what Next needs to serve this app, not the workspace's build toolchain.
  output: 'standalone',
};

export default nextConfig;
