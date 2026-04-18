import { Router, type IRouter } from "express";

const router: IRouter = Router();

let _visitCount = 0;

function seededRng(seed: number, slot: number): number {
  const x = Math.sin(seed * 9301 + slot * 49297 + 233) * 10000;
  return x - Math.floor(x);
}

router.get("/test-page-data", (_req, res): void => {
  _visitCount++;
  const visit = _visitCount;
  const now = new Date();

  const products = [
    { name: "WebApp Pro",   base: 99.99,  icon: "🟦" },
    { name: "API Gateway",  base: 49.99,  icon: "🟩" },
    { name: "Data Lake",    base: 199.99, icon: "🟪" },
    { name: "ML Pipeline",  base: 299.99, icon: "🟧" },
    { name: "Edge CDN",     base: 29.99,  icon: "🟨" },
  ].map((p, i) => {
    const pct = (seededRng(visit, i * 17) - 0.48) * 0.22;
    const price = +(p.base * (1 + pct)).toFixed(2);
    const change = +((seededRng(visit, i * 31) - 0.5) * 12).toFixed(2);
    const dirs = ["up", "down", "stable"] as const;
    const dir = dirs[Math.floor(seededRng(visit, i * 7) * 3)];
    return { name: p.name, icon: p.icon, price, change, direction: dir };
  });

  const serviceNames = ["API Server", "Database", "CDN", "Auth", "Storage", "Webhooks"];
  const statusValues = ["operational", "degraded", "outage", "maintenance"] as const;
  const services = serviceNames.map((name, i) => ({
    name,
    status: statusValues[Math.floor(seededRng(visit, i * 11) * 4)],
  }));

  const alertValues = ["none", "info", "warning", "critical"] as const;
  const alert = alertValues[Math.floor(seededRng(visit, 99) * 4)];

  const uptime = +(99.9 - seededRng(visit, 77) * 0.5).toFixed(3);
  const responseTime = Math.floor(seededRng(visit, 55) * 250 + 18);
  const activeUsers = Math.floor(seededRng(visit, 33) * 600 + 80);
  const errorRate = +(seededRng(visit, 22) * 0.8).toFixed(2);

  const headlinePool = [
    "New API rate limit policy takes effect",
    "Scheduled maintenance window tonight",
    "CDN performance improved by 34%",
    "Security patch applied to all nodes",
    "Database replication lag resolved",
    "New regions added: Tokyo and São Paulo",
    "Webhooks now support retry exponential backoff",
    "Auth service latency spike detected",
    "Storage costs reduced — new compression engine",
    "Edge caching rules updated",
  ];

  const headlines = [0, 1, 2].map(i => {
    const idx = Math.floor(seededRng(visit, i * 13 + 5) * headlinePool.length);
    const minsAgo = Math.floor(seededRng(visit, i * 19 + 3) * 120);
    return {
      title: headlinePool[idx],
      minsAgo,
      category: ["System", "Security", "Performance", "Infrastructure"][Math.floor(seededRng(visit, i * 23) * 4)],
    };
  });

  const logEntries = Array.from({ length: 6 }, (_, i) => {
    const levels = ["INFO", "WARN", "ERROR", "DEBUG"] as const;
    const level = levels[Math.floor(seededRng(visit, i * 41 + 7) * 4)];
    const msgs: Record<typeof levels[number], string[]> = {
      INFO:  ["Request served", "Cache hit", "Health check passed", "Session created"],
      WARN:  ["Slow query detected", "Rate limit approaching", "Memory usage high", "Retry attempt #2"],
      ERROR: ["Connection timeout", "Invalid token", "Disk quota exceeded", "Upstream 503"],
      DEBUG: ["Parsing request body", "Cache miss", "DB query plan", "Token validated"],
    };
    const msgArr = msgs[level];
    const msg = msgArr[Math.floor(seededRng(visit, i * 53 + 11) * msgArr.length)];
    const secsAgo = Math.floor(seededRng(visit, i * 17 + 2) * 300);
    return { level, msg, secsAgo };
  });

  res.json({
    visitCount: visit,
    timestamp: now.toISOString(),
    serverTime: now.toLocaleTimeString("en-US", { hour12: false }),
    products,
    services,
    alert,
    uptime,
    responseTime,
    activeUsers,
    errorRate,
    headlines,
    logEntries,
  });
});

export default router;
