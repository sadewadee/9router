export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Daily CodeBuddy check-in. Started here because register() is the one hook
    // that reliably runs at boot in the standalone/Docker server; initializeApp
    // also starts it (idempotent). A failure must never take the server down.
    try {
      const { startCodebuddyCheckin } = await import("@/sse/services/codebuddyCheckin.js");
      startCodebuddyCheckin();
    } catch (e) {
      console.log("[CodebuddyCheckin] scheduler start failed:", e.message);
    }
  }
}
