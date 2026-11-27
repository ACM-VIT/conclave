// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReconnectInviteCodeForm from "../src/app/components/ReconnectInviteCodeForm";

let container: HTMLDivElement;
let root: Root;

const typeInto = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("rejoins with the code the user typed", async () => {
  const onSubmit = vi.fn();
  await act(async () =>
    root.render(<ReconnectInviteCodeForm isBusy={false} onSubmit={onSubmit} />),
  );
  const input = container.querySelector("input")!;
  const rejoin = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  expect(rejoin.disabled).toBe(true);
  await act(async () => typeInto(input, "  probe-code-1 "));
  expect(rejoin.disabled).toBe(false);
  await act(async () => rejoin.click());

  expect(onSubmit).toHaveBeenCalledWith("probe-code-1");
});

it("does not submit while a rejoin is already running", async () => {
  const onSubmit = vi.fn();
  await act(async () =>
    root.render(<ReconnectInviteCodeForm isBusy onSubmit={onSubmit} />),
  );
  await act(async () => typeInto(container.querySelector("input")!, "code"));
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );

  expect(onSubmit).not.toHaveBeenCalled();
});
