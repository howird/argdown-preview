// Builds dist/ once before the tests that run it.
import { execFileSync } from "node:child_process";

export default () => {
  execFileSync(process.execPath, ["build.mjs"], { stdio: "inherit" });
};
