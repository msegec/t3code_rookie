import { isEntrypoint } from "./entrypoint.ts";
import { runServiceLauncher } from "./serviceLauncher.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  runServiceLauncher().catch((cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    process.stderr.write(`[service-launcher] ${error.message}\n`);
    process.exitCode = 1;
  });
}
