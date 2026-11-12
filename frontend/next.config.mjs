import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeBackendUrl(raw) {
  let val = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  if (!val) return "http://127.0.0.1:4000";
  if (!/^https?:\/\//i.test(val)) {
    val = `https://${val}`;
  }
  return val.replace(/\/+$/, "");
}

/** @type {import('next').NextConfig} */
const backendUrl = normalizeBackendUrl(process.env.BACKEND_URL);

const nextConfig = {
  outputFileTracingRoot: __dirname,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: "/candidate.html",
        destination: "/candidate",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
