import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ id: z.string().regex(/^[a-f0-9]{12}$/).optional() }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  await u.mediaKeyPool.reset(req.body.id);
  res.set("Cache-Control", "no-store").json(success(await u.mediaKeyPool.snapshot()));
});
