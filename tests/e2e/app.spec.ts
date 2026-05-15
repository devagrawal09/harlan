import { expect, test } from "@playwright/test";

const promptPlaceholder =
  "Ask Harlan to inspect the repo, summarize files, or continue this session.";

test("creates, renames, and deletes sessions", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Session title" })).toHaveValue(
    "Untitled session",
  );
  await expect(page.getByLabel("Event log")).toContainText("Session started");

  const sessionCount = await page.getByRole("button", { name: "Untitled session" }).count();
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByRole("textbox", { name: "Session title" })).toHaveValue(
    "Untitled session",
  );
  await expect(page.getByRole("button", { name: "Untitled session" })).toHaveCount(
    sessionCount + 1,
  );

  await page.getByRole("textbox", { name: "Session title" }).fill("E2E renamed session");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("button", { name: "E2E renamed session" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: "E2E renamed session" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Session title" })).toHaveValue(
    "Untitled session",
  );
});

test("runs a prompt and renders streamed domain events", async ({ page }) => {
  await page.goto("/");

  await page.getByPlaceholder(promptPlaceholder).fill("Summarize the project");
  await page.getByRole("button", { name: "Run" }).click();

  await expect(page.locator("span").filter({ hasText: /^running$/ })).toBeVisible();
  await expect(page.getByLabel("Event log")).toContainText("User");
  await expect(page.getByLabel("Event log")).toContainText("Summarize the project");
  await expect(page.getByLabel("Event log")).toContainText("Harlan executed");
  await expect(page.getByLabel("Event log")).toContainText('inspect("Summarize the project")');
  await expect(page.getByLabel("Event log")).toContainText("Execution completed");
  await expect(page.getByLabel("Event log")).toContainText("inspected: Summarize the project");
  await expect(page.getByLabel("Event log")).toContainText("Finished: Summarize the project");
  await expect(page.locator("span").filter({ hasText: /^done$/ })).toBeVisible();
  await expect(page.getByPlaceholder(promptPlaceholder)).toHaveValue("");
});
