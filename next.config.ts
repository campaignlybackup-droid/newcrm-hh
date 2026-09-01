import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: false,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
