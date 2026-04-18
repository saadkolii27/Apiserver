import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import monitorsRouter from "./monitors";
import snapshotsRouter from "./snapshots";
import notificationsRouter from "./notifications";
import dashboardRouter from "./dashboard";
import previewRouter from "./preview";
import testPageRouter from "./test-page";
import billingRouter from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(monitorsRouter);
router.use(snapshotsRouter);
router.use(notificationsRouter);
router.use(dashboardRouter);
router.use(previewRouter);
router.use(testPageRouter);
router.use(billingRouter);

export default router;
