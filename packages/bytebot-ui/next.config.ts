import type { NextConfig } from "next";
import dotenv from "dotenv";

dotenv.config();

const nextConfig: NextConfig = {
  transpilePackages: ["@bytebot/shared"],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:9991/api/:path*',
      },
    ];
  },
};

export default nextConfig;
