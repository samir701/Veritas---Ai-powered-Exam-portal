import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const certDir = path.resolve(__dirname, "..", ".cert");
const keyPath = path.join(certDir, "key.pem");
const certPath = path.join(certDir, "cert.pem");
const cnfPath = path.join(certDir, "openssl.cnf");

const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1";
const TARGET_PORT = Number(process.env.TARGET_PORT || 3000);

function getLocalIPv4s() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const info of entries || []) {
      if (info.family === "IPv4" && !info.internal) {
        ips.push(info.address);
      }
    }
  }
  return ips;
}

function findOpenssl() {
  const candidates = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["version"], { stdio: "ignore" });
      return bin;
    } catch {
      // try next
    }
  }
  return null;
}

function ensureCert(lanIps) {
  fs.mkdirSync(certDir, { recursive: true });
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return;
  }
  const openssl = findOpenssl();
  if (!openssl) {
    throw new Error("OpenSSL not found; cannot generate local HTTPS certificate.");
  }

  const sanEntries = ["DNS:localhost", "IP:127.0.0.1", ...lanIps.map((ip) => `IP:${ip}`)].join(",");
  fs.writeFileSync(
    cnfPath,
    `[req]
default_bits = 2048
prompt = no
default_md = sha256
x509_extensions = v3_req
distinguished_name = dn

[dn]
CN = localhost

[v3_req]
subjectAltName = ${sanEntries}
`,
    "utf8"
  );

  execFileSync(
    openssl,
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365", "-keyout", keyPath, "-out", certPath, "-config", cnfPath],
    { stdio: "inherit" }
  );
}

const lanIps = getLocalIPv4s();
ensureCert(lanIps);

const server = https.createServer(
  {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  },
  (req, res) => {
    const proxyReq = http.request(
      {
        hostname: TARGET_HOST,
        port: TARGET_PORT,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          "x-forwarded-proto": "https",
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      }
    );

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end(`HTTPS proxy error: ${err.message}`);
    });

    req.pipe(proxyReq, { end: true });
  }
);

server.listen(HTTPS_PORT, "0.0.0.0", () => {
  console.log(`HTTPS dev proxy listening on https://localhost:${HTTPS_PORT}`);
  for (const ip of lanIps) {
    console.log(`Mobile LAN HTTPS URL: https://${ip}:${HTTPS_PORT}`);
  }
});

