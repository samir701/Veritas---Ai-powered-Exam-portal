import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const { app } = createApp(config);

export default app;

