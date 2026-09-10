import { _electron as electron } from "@playwright/test";
export async function launch(directory: string, hidden = false) {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SPARK_DESKTOP_TEST_DATA: directory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ["dist-desktop/main.cjs"], env, timeout: 30_000 });
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, hidden) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setTitle("TEST · Blink Spark backup");
    if (hidden) window.hide();
  }, hidden);
  return app;
}
