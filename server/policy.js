import { createHash } from "node:crypto";
import { CINEMETA_CATALOGS_ORIGIN, CINEMETA_ORIGIN } from "../src/catalog.js";

function hash(content) {
  return `'sha256-${createHash("sha256").update(content).digest("base64")}'`;
}

export function documentPolicy(html, { standalone = false } = {}) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  const style = html.match(/<style>([\s\S]*?)<\/style>/u)?.[1];
  if (!script || !style) throw new Error("The compiled HTML is missing its script or style. Run npm run build.");
  const sources = standalone ? `'self' ${CINEMETA_ORIGIN} ${CINEMETA_CATALOGS_ORIGIN}` : "'self'";
  const directives = [
    "default-src 'none'", `script-src ${hash(script)}`, `style-src ${hash(style)}`,
    "img-src https: data: blob:", "font-src data:", `connect-src ${sources}`, "base-uri 'none'", "form-action 'none'",
    "object-src 'none'",
  ];
  if (!standalone) directives.push("frame-ancestors 'none'");
  return directives.join("; ");
}
