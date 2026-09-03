/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The console is a thin client over apps/api. It never imports a server package and
  // never reads a server secret; only NEXT_PUBLIC_API_BASE_URL may reach the browser.
  env: {},
  typedRoutes: true,
};

export default nextConfig;
