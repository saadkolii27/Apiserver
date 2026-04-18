import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "http";
import { getSession } from "./auth";
import { logger } from "./logger";
import {
  createSession as createBrowserSession,
  handleMouseEvent,
  handleKeyEvent,
  handleScroll,
  destroySession as destroyBrowserSession,
  setSessionMode,
  startSessionCleanup,
  replayActionsInSession,
} from "./browserSession";

let _io: SocketIOServer | null = null;

export function initSocketIO(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    path: "/api/socket.io",
    cors: {
      origin: true,
      credentials: true,
    },
    transports: ["polling", "websocket"],
  });

  io.use((socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie ?? "";
      const sessionToken = parseCookieValue(cookieHeader, "session");
      if (!sessionToken) {
        return next(new Error("Not authenticated"));
      }
      const session = getSession(sessionToken);
      if (!session) {
        return next(new Error("Session expired or invalid"));
      }
      (socket as typeof socket & { userId: number }).userId = session.userId;
      next();
    } catch (err) {
      next(new Error("Auth error"));
    }
  });

  io.on("connection", (socket) => {
    const userId = (socket as typeof socket & { userId: number }).userId;
    const room = `user:${userId}`;
    void socket.join(room);
    logger.info({ userId, socketId: socket.id }, "Socket connected");

    let activeBrowserKey: string | null = null;

    socket.on("browser:start", async (data: { monitorId: string; url: string; mode?: string }) => {
      try {
        if (activeBrowserKey) {
          await destroyBrowserSession(activeBrowserKey);
          activeBrowserKey = null;
        }

        const mode = (data.mode === "select" || data.mode === "record") ? data.mode : "browse";

        const result = await createBrowserSession(
          userId,
          data.monitorId,
          data.url,
          (frameData: string) => {
            socket.emit("browser:frame", { data: frameData });
          },
          {
            mode: mode as "browse" | "select" | "record",
            onSelector: (selector: string) => {
              socket.emit("browser:selector", { selector });
            },
            onAction: (action) => {
              socket.emit("browser:action", { action });
            },
          },
        );

        activeBrowserKey = result.sessionKey;
        socket.emit("browser:started", {
          sessionKey: result.sessionKey,
          width: result.width,
          height: result.height,
        });
      } catch (err) {
        logger.error({ err, userId }, "Failed to start browser session");
        socket.emit("browser:error", { message: "Failed to start browser session" });
      }
    });

    socket.on("browser:setMode", async (data: { mode: string }) => {
      if (!activeBrowserKey) return;
      const mode = (data.mode === "select" || data.mode === "record" || data.mode === "browse") ? data.mode : "browse";
      await setSessionMode(
        activeBrowserKey,
        mode as "browse" | "select" | "record",
        {
          onSelector: (selector: string) => {
            socket.emit("browser:selector", { selector });
          },
          onAction: (action) => {
            socket.emit("browser:action", { action });
          },
        },
      );
    });

    socket.on("browser:mouse", (data: {
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      deltaX?: number;
      deltaY?: number;
    }) => {
      if (!activeBrowserKey) return;
      handleMouseEvent(
        activeBrowserKey,
        data.type,
        data.x,
        data.y,
        data.button,
        data.deltaX,
        data.deltaY,
      ).catch(() => {});
    });

    socket.on("browser:key", (data: {
      type: "keyDown" | "keyUp";
      key: string;
      code: string;
      text?: string;
      modifiers?: number;
    }) => {
      if (!activeBrowserKey) return;
      handleKeyEvent(
        activeBrowserKey,
        data.type,
        data.key,
        data.code,
        data.text,
        data.modifiers,
      ).catch(() => {});
    });

    socket.on("browser:scroll", (data: {
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }) => {
      if (!activeBrowserKey) return;
      handleScroll(
        activeBrowserKey,
        data.x,
        data.y,
        data.deltaX,
        data.deltaY,
      ).catch(() => {});
    });

    socket.on("browser:runSingleStep", (data: { action: unknown }) => {
      if (!activeBrowserKey) {
        socket.emit("browser:singleStepResult", { status: "error", error: "No active browser session" });
        return;
      }
      const actions = [data.action] as Parameters<typeof replayActionsInSession>[1];
      replayActionsInSession(
        activeBrowserKey,
        actions,
        (_index, status, error) => {
          if (status !== "start") {
            socket.emit("browser:singleStepResult", { status, error });
          }
        },
        () => {},
      ).catch((err) => {
        logger.error({ err, userId }, "Run single step failed");
        socket.emit("browser:singleStepResult", { status: "error", error: String(err) });
      });
    });

    socket.on("browser:replay", (data: { actions: unknown[] }) => {
      if (!activeBrowserKey) {
        socket.emit("browser:replayDone", { totalSteps: 0, error: "No active browser session" });
        return;
      }
      const actions = Array.isArray(data.actions) ? data.actions : [];
      replayActionsInSession(
        activeBrowserKey,
        actions as Parameters<typeof replayActionsInSession>[1],
        (index, status, error) => {
          socket.emit("browser:replayStep", { index, status, error });
        },
        () => {
          socket.emit("browser:replayDone", { totalSteps: actions.length });
        },
      ).catch((err) => {
        logger.error({ err, userId }, "Replay actions failed");
        socket.emit("browser:replayDone", { totalSteps: 0, error: "Replay failed" });
      });
    });

    socket.on("browser:stop", async () => {
      if (activeBrowserKey) {
        await destroyBrowserSession(activeBrowserKey);
        activeBrowserKey = null;
        socket.emit("browser:stopped");
      }
    });

    socket.on("disconnect", async (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, "Socket disconnected");
      if (activeBrowserKey) {
        await destroyBrowserSession(activeBrowserKey).catch(() => {});
        activeBrowserKey = null;
      }
    });
  });

  _io = io;
  return io;
}

export function getIO(): SocketIOServer | null {
  return _io;
}

export function emitToUser(userId: number, event: string, data: unknown): void {
  if (!_io) return;
  _io.to(`user:${userId}`).emit(event, data);
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=");
    if (key?.trim() === name) {
      return decodeURIComponent(rest.join("=").trim());
    }
  }
  return null;
}
