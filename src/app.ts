import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", router);

// In production, serve the web-monitor static frontend from the same process.
// This is required for the Reserved VM deployment, which runs a single root
// process (the API server) — there is no separate static file server.
if (process.env["NODE_ENV"] === "production") {
  const candidatePaths = [
    // When running from the built artifacts/api-server/dist/index.mjs at the
    // repo root (Reserved VM start.sh), the web-monitor build output lives at
    // <repo>/artifacts/web-monitor/dist/public.
    path.resolve(process.cwd(), "artifacts/web-monitor/dist/public"),
    // Fallback in case the working directory is the api-server folder itself.
    path.resolve(process.cwd(), "../web-monitor/dist/public"),
  ];

  const staticDir = candidatePaths.find((candidate) =>
    fs.existsSync(path.join(candidate, "index.html")),
  );

  if (staticDir) {
    logger.info({ staticDir }, "Serving web-monitor static files");

    app.use(
      express.static(staticDir, {
        index: false,
        // Long-cache hashed assets, never cache the HTML entry point.
        setHeaders: (res, filePath) => {
          if (filePath.endsWith("index.html")) {
            res.setHeader("Cache-Control", "no-cache, must-revalidate");
          }
        },
      }),
    );

    // SPA fallback — anything not matched by /api/* or a static file should
    // return index.html so client-side routing works.
    app.get(/^(?!\/api(?:\/|$)).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  } else {
    logger.warn(
      { candidatePaths },
      "Web-monitor static files not found; only /api routes will be served",
    );
  }
}

export default app;
