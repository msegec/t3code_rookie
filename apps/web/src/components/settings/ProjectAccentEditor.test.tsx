import type { ProjectAccent } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/toggle-group", () => ({ ToggleGroup: "toggle-group", Toggle: "toggle" }));

import { ProjectAccentEditor } from "./ProjectAccentEditor";

let renderer: ReactTestRenderer;
const onSave = vi.fn<(accent: ProjectAccent | null) => Promise<void>>();

function mount(current: ProjectAccent | null = null) {
  act(() => {
    renderer = create(<ProjectAccentEditor current={current} onSave={onSave} />);
  });
}

function button(label: string) {
  return renderer.root.findAllByType("button").find((item) => item.children.includes(label))!;
}

function field(label: string) {
  return renderer.root.findAllByType("input").find((item) => item.props["aria-label"] === label)!;
}

function change(label: string, value: string) {
  act(() => field(label).props.onChange({ currentTarget: { value } }));
}

function mode(value: string) {
  act(() =>
    renderer.root.findByProps({ "aria-label": "Sidebar accent mode" }).props.onValueChange([value]),
  );
}

async function click(label: string) {
  await act(async () => {
    button(label).props.onClick();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSave.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("ProjectAccentEditor", () => {
  it("edits presets, custom hex and the colour picker without saving until requested", async () => {
    mount();
    expect(button("Save accent").props.disabled).toBe(true);
    act(() => renderer.root.findByProps({ "aria-label": "Accent: Purple" }).props.onClick());
    expect(field("Accent hex colour").props.value).toBe("#8b5cf6");
    change("Accent colour picker", "#123456");
    expect(field("Accent hex colour").props.value).toBe("#123456");
    change("Accent hex colour", " #ABCDEF ");
    expect(onSave).not.toHaveBeenCalled();
    await click("Save accent");
    expect(onSave).toHaveBeenCalledExactlyOnceWith("#ABCDEF");
    expect(button("Save accent").props.disabled).toBe(true);
  });

  it("saves exact advanced colours and returns to the idle colour in Simple mode", async () => {
    mount("#123456");
    mode("advanced");
    expect(field("Idle hex colour").props.value).toBe("#123456");
    change("Active hex colour", "#abcdef");
    change("Selected hex colour", "#654321");
    await click("Save accent");
    expect(onSave).toHaveBeenLastCalledWith({
      idle: "#123456",
      active: "#abcdef",
      selected: "#654321",
    });
    mode("simple");
    await click("Save accent");
    expect(onSave).toHaveBeenLastCalledWith("#123456");
  });

  it("keeps invalid text visible and prevents saving it", () => {
    mount("#123456");
    change("Accent hex colour", "#bad");
    expect(field("Accent hex colour").props["aria-invalid"]).toBe(true);
    expect(field("Accent hex colour").props.value).toBe("#bad");
    expect(button("Save accent").props.disabled).toBe(true);
    act(() => button("Save accent").props.onClick());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("retains a failed draft for retry and persists Reset as null", async () => {
    mount("#123456");
    change("Accent hex colour", "#abcdef");
    onSave.mockRejectedValueOnce(new Error("Write failed"));
    await click("Save accent");
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["Write failed"]);
    expect(field("Accent hex colour").props.value).toBe("#abcdef");
    expect(button("Save accent").props.disabled).toBe(false);
    onSave.mockRejectedValueOnce(new Error("Reset failed"));
    await click("Reset");
    expect(field("Accent hex colour").props.value).toBe("#abcdef");
    await click("Save accent");
    expect(onSave).toHaveBeenLastCalledWith("#abcdef");
    await click("Reset");
    expect(onSave).toHaveBeenLastCalledWith(null);
    expect(button("Save accent").props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("accepts external changes while clean and preserves unsaved edits", () => {
    mount("#123456");
    act(() => renderer.update(<ProjectAccentEditor current="#abcdef" onSave={onSave} />));
    expect(field("Accent hex colour").props.value).toBe("#abcdef");
    change("Accent hex colour", "#112233");
    act(() => renderer.update(<ProjectAccentEditor current="#654321" onSave={onSave} />));
    expect(field("Accent hex colour").props.value).toBe("#112233");
  });
});
