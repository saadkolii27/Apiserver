import dns from "dns/promises";
import net from "net";

function isPrivateOrLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80")) return true;
    if (lower.startsWith("::ffff:")) {
      return isPrivateOrLoopbackIp(lower.slice(7));
    }
    return false;
  }
  return false;
}

export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  let host = parsed.hostname;
  if (!host) throw new Error("Missing hostname");
  // URL.hostname keeps brackets around IPv6 literals; strip them so net.isIP works.
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  const lcHost = host.toLowerCase();
  if (
    lcHost === "localhost" ||
    lcHost === "metadata.google.internal" ||
    lcHost.endsWith(".internal") ||
    lcHost.endsWith(".local")
  ) {
    throw new Error("Refusing to fetch internal host");
  }
  if (net.isIP(host)) {
    if (isPrivateOrLoopbackIp(host)) {
      throw new Error("Refusing to fetch private/loopback IP");
    }
    return;
  }
  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateOrLoopbackIp(r.address)) {
        throw new Error("Hostname resolves to private/loopback IP");
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Hostname resolves")) throw err;
  }
}
