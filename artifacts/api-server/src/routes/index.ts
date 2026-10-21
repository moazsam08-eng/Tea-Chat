import { Router, type IRouter } from "express";
import healthRouter from "./health";
import streamRouter from "./stream";
import assistantRouter from "./assistant";

const router: IRouter = Router();

router.use(healthRouter);
router.use(streamRouter);
router.use(assistantRouter);

export default router;
