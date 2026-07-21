import path from "path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd()),

  async rewrites() {
    return [
      {
          source: "/api/:path*",
          destination: "http://localhost:5000/api/:path*",
      },
    ];
  },
};

export default nextConfig;