import { loadConfig } from "./platform/config/env.js";

const config = loadConfig();

process.stdout.write(`pokemon-rpg-engine ready (${config.appEnv})\n`);
