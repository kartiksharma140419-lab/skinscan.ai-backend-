import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import userRouter from "./user.js";
import scanRouter from "./scan.js";
import trackerRouter from "./tracker.js";
import paymentRouter from "./payment.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/user", userRouter);
router.use("/scan", scanRouter);
router.use("/tracker", trackerRouter);
router.use("/payment", paymentRouter);

export default router;
