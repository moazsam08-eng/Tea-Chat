import { Router, type IRouter } from "express";
import healthRouter from "./health";
import streamRouter from "./stream";
import messageLimitsRouter from "./message-limits";

const router: IRouter = Router();

router.use(healthRouter);
router.use(streamRouter);
router.use(messageLimitsRouter);

export default router;
