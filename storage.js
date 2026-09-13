/* Persistent media storage abstraction.
 *
 * In production, product images and videos must survive Render restarts,
 * sleep/wake cycles, instance replacement and redeploys — everything on
 * Render's local disk is ephemeral. Media is therefore pushed to S3-compatible
 * object storage (AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces,
 * MinIO, ...) and PostgreSQL stores the permanent public URL.
 *
 * When no S3 endpoint is configured the app falls back to writing files under
 * public/uploads (the historic localhost behaviour) so local development keeps
 * working unchanged. That fallback is NOT persistent on Render — the server
 * logs a warning in production when it is active.
 *
 * All credentials come from environment variables; nothing is hardcoded.
 * See .env.example for the full list.
 */
const { Client: S3Client } = require("minio");

const S3_ENDPOINT = String(process.env.S3_ENDPOINT || "").trim();
const S3_REGION = String(process.env.S3_REGION || "us-east-1").trim();
const S3_ACCESS_KEY = String(process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "").trim();
const S3_SECRET_KEY = String(process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "").trim();
const S3_BUCKET = String(process.env.S3_BUCKET || "").trim();
const S3_PUBLIC_URL = String(process.env.S3_PUBLIC_URL || process.env.S3_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const S3_PREFIX = String(process.env.S3_UPLOAD_PREFIX || "").trim().replace(/^\/+|\/+$/g, "");
const S3_FORCE_PATH_STYLE = /^(1|true|yes)$/i.test(String(process.env.S3_FORCE_PATH_STYLE || "").trim());
const S3_ENDPOINT_SSL_RAW = String(process.env.S3_ENDPOINT_SSL || "").trim();

const configured = Boolean(S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY);

let client = null;
function getClient() {
  if (client) return client;
  const parts = parseEndpoint();
  client = new S3Client({
    endPoint: parts.host,
    port: parts.port,
    useSSL: parts.useSSL,
    accessKey: S3_ACCESS_KEY,
    secretKey: S3_SECRET_KEY,
    region: S3_REGION,
    pathStyle: S3_FORCE_PATH_STYLE || Boolean(S3_ENDPOINT)
  });
  return client;
}

/* Endpoint input forms: "s3.amazonaws.com", "s3.amazonaws.com:9000",
   "https://myaccount.r2.cloudflarestorage.com", "http://localhost:9000" */
function parseEndpoint() {
  let s = S3_ENDPOINT || "s3.amazonaws.com";
  let useSSL = true;
  if (/^http:\/\//i.test(s)) useSSL = false;
  s = s.replace(/^https?:\/\//i, "").split("/")[0];
  let host = s;
  let port = null;
  if (s.charAt(0) === "[") {
    const end = s.indexOf("]");
    host = s.slice(1, end);
    const m = s.slice(end + 1).match(/^:(\d+)/);
    if (m) port = Number(m[1]);
  } else {
    const idx = s.lastIndexOf(":");
    if (idx > 0 && /^\d+$/.test(s.slice(idx + 1))) {
      host = s.slice(0, idx);
      port = Number(s.slice(idx + 1));
    }
  }
  if (/^(1|true|yes)$/i.test(S3_ENDPOINT_SSL_RAW)) useSSL = true;
  else if (/^(0|false|no)$/i.test(S3_ENDPOINT_SSL_RAW)) useSSL = false;
  if (!port) port = useSSL ? 443 : 80;
  return { host, port, useSSL };
}

function defaultPublicBase() {
  const p = parseEndpoint();
  return `${p.useSSL ? "https" : "http"}://${p.host}:${p.port}/${S3_BUCKET}`;
}

function isS3() {
  return configured;
}

/* Uploads a file stream. key is the generated, safe filename (e.g.
   "1699999999999-a1b2c3d4e5f6.jpg"); the optional S3_UPLOAD_PREFIX is
   prepended automatically. Resolves to { key, url } when stored. */
async function put({ key, kind, size, stream, contentType }) {
  if (!configured) throw new Error("Object storage is not configured — cannot persist media.");
  const fullKey = S3_PREFIX ? `${S3_PREFIX}/${key}` : key;
  const meta = { "Content-Type": contentType || (kind === "videos" ? "video/mp4" : "image/jpeg") };
  await getClient().putObject(S3_BUCKET, fullKey, stream, size, meta);
  const base = S3_PUBLIC_URL || defaultPublicBase();
  return { key: fullKey, url: `${base}/${fullKey}` };
}

/* Best-effort delete of an object previously stored by this app. Accepts the
   public URL or the raw object key. */
async function remove(urlOrKey) {
  if (!configured) return null;
  const raw = String(urlOrKey || "").trim().replace(/^\/+/, "");
  if (!raw) return null;
  let key = raw;
  if (/^https?:\/\//i.test(raw)) {
    if (S3_PUBLIC_URL && raw.startsWith(S3_PUBLIC_URL)) key = raw.slice(S3_PUBLIC_URL.length).replace(/^\/+/, "");
    else return null; /* not one of our objects — leave it alone */
  }
  if (!key) return null;
  return getClient().removeObject(S3_BUCKET, key);
}

/* Boot-time reachability check. Resolves to a short status string. */
async function check() {
  if (!configured) return "local filesystem";
  try {
    await getClient().bucketExists(S3_BUCKET);
    return "bucket OK";
  } catch (err) {
    return `unreachable: ${err && err.message ? err.message : String(err)}`;
  }
}

function describe() {
  if (!configured) return "local filesystem (public/uploads) — NOT persistent on Render; set the S3_* variables to use object storage";
  const p = parseEndpoint();
  const host = S3_ENDPOINT || `${p.host}:${p.port}`;
  const url = S3_PUBLIC_URL || `${p.useSSL ? "https" : "http"}://${p.host}:${p.port}/${S3_BUCKET}`;
  return `S3-compatible object storage (${host}, bucket "${S3_BUCKET}") → ${url}`;
}

module.exports = { isS3, put, remove, check, describe };