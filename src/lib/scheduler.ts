import cron from "node-cron";
import { checkAllActiveMonitors } from "./checker";
import { logger } from "./logger";

let schedulerRunning = false;

export function startScheduler(): void {
  cron.schedule("*/15 * * * * *", () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    logger.info("Scheduler: running monitor checks");
    checkAllActiveMonitors()
      .catch(err => logger.error({ err }, "Scheduler: error during monitor checks"))
      .finally(() => { schedulerRunning = false; });
  });

  logger.info("Scheduler started — running checks every 15 seconds");
}
