/** @type {import('next').NextConfig} */
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

module.exports = {
  output: "standalone",
  basePath: BASE_PATH,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
      { source: "/ws/:path*", destination: `${API_URL}/ws/:path*` },
      { source: "/yws/:path*", destination: `${API_URL}/yws/:path*` },
    ];
  },
};
