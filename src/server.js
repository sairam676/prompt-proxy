import "dotenv/config";
import express    from "express";
import cors       from "cors";
import { connectRedis } from "./cache/redis.js";
import chatRouter       from "./routes/chat.js";

const app  = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());
app.use("/api/chat", chatRouter);
app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

const start = async () => {
  try {
    const redis = connectRedis();
    await redis.ping();
    console.log("[Redis] Ping OK");
    app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));
  } catch (err) {
    console.error("[Boot] Failed:", err.message);
    process.exit(1);
  }
};

start();