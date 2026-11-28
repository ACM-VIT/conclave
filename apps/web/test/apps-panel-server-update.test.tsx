// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppsPanel, type PanelAppEntry } from "../src/app/components/apps/AppsPanel";

vi.mock("@conclave/apps-sdk", () => ({
  useApps: () => ({
    apps: [],
    state: { activeAppId: null, locked: false },
    openApp: async () => true,
    closeApp: async () => true,
    setLocked: async () => true,
    isAdmin: true,
    isReadOnly: false,
  }),
}));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const entry = (overrides: Partial<PanelAppEntry>): PanelAppEntry => ({
  id: "polls",
  name: "Polls",
  icon: null,
  isOpen: false,
  onToggle: () => {},
  ...overrides,
});

const row = (id: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="panel-app-${id}"]`);

it("lists an app the server cannot run as off, and says why in plain words", async () => {
  const onToggle = vi.fn();
  await act(async () =>
    root.render(
      <AppsPanel
        onClose={() => {}}
        panelApps={[
          entry({ needsServerUpdate: true, onToggle }),
          entry({ id: "qa", name: "Q&A", needsServerUpdate: true, onToggle }),
        ]}
      />,
    ),
  );
  await act(async () => row("polls")?.click());

  expect(row("polls")?.disabled).toBe(true);
  expect(row("polls")?.textContent).toContain("Polls");
  expect(row("polls")?.textContent).toContain("Needs a server update");
  expect(row("polls")?.title).toBe("Needs a server update");
  expect(row("polls")?.getAttribute("aria-label")).toBe("Polls: needs a server update");
  expect(row("qa")?.disabled).toBe(true);
  expect(row("qa")?.textContent).toContain("Needs a server update");
  expect(onToggle).not.toHaveBeenCalled();
});

it("leaves an app the server offers as it was", async () => {
  const onToggle = vi.fn();
  await act(async () =>
    root.render(<AppsPanel onClose={() => {}} panelApps={[entry({ onToggle })]} />),
  );
  await act(async () => row("polls")?.click());

  expect(row("polls")?.disabled).toBe(false);
  expect(row("polls")?.getAttribute("aria-label")).toBe("Open Polls");
  expect(row("polls")?.textContent).toBe("Polls");
  expect(onToggle).toHaveBeenCalledTimes(1);
});

it("says when an app is waiting for this viewer, until it is open", async () => {
  await act(async () =>
    root.render(<AppsPanel onClose={() => {}} panelApps={[entry({ needsAttention: true })]} />),
  );
  expect(row("polls")?.textContent).toContain("New");

  await act(async () =>
    root.render(
      <AppsPanel onClose={() => {}} panelApps={[entry({ needsAttention: true, isOpen: true })]} />,
    ),
  );
  expect(row("polls")?.textContent).not.toContain("New");
  expect(row("polls")?.getAttribute("aria-pressed")).toBe("true");
});
