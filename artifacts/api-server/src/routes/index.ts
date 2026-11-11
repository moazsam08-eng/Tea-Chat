import { Router, type IRouter } from "express";
import healthRouter from "./health";
import streamRouter from "./stream";
import messageLimitsRouter from "./message-limits";
import maintenanceRouter from "./maintenance";

const router: IRouter = Router();

router.use(healthRouter);
router.use(streamRouter);
router.use(messageLimitsRouter);
router.use(maintenanceRouter);

export default router;
