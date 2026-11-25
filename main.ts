// Pump.fun Sharpe Sprint — entrypoint. Wires the calm-dip scalper strategy to
// the agent-fun/replay/v2 harness through the kit's vendored shim.
// Runs as `node /bot/main.ts` under the grader (Node strips the types).
import { runBot } from "./vendor/makefun-bot.ts";
import { createStrategy } from "./strategy.ts";

await runBot(createStrategy());
