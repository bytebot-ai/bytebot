import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  transpilePackages: ['../shared'],
  experimental: {
    externalDir: true,
  }
};

export default nextConfig;
