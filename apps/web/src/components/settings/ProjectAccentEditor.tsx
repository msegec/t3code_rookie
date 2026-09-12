import { ProjectAccent, ProjectAccentColor } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const PRESETS = [
  ["Blue", "#1688f0"],
  ["Purple", "#8b5cf6"],
  ["Pink", "#ec4899"],
  ["Red", "#ef4444"],
  ["Orange", "#f97316"],
  ["Amber", "#eab308"],
  ["Green", "#22c55e"],
  ["Teal", "#14b8a6"],
] as const;
const DEFAULT_COLOR = PRESETS[0][1];
const decodeAccent = Schema.decodeUnknownOption(ProjectAccent);
const decodeColor = Schema.decodeUnknownOption(ProjectAccentColor);

export function ProjectAccentEditor({
  current,
  onSave,
}: {
  current: ProjectAccent | null;
  onSave: (accent: ProjectAccent | null) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState({ value: current, source: current, dirty: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (draft.source !== current) {
    setDraft({
      value: draft.dirty ? draft.value : current,
      source: current,
      dirty: draft.dirty,
    });
  }

  const value = draft.value ?? DEFAULT_COLOR;
  const advanced = typeof value !== "string";
  const parsed = decodeAccent(value);
  const rows =
    typeof value === "string"
      ? [{ key: "idle" as const, label: "Accent", color: value }]
      : [
          { key: "idle" as const, label: "Idle", color: value.idle },
          { key: "active" as const, label: "Active", color: value.active },
          { key: "selected" as const, label: "Selected", color: value.selected },
        ];

  function edit(next: ProjectAccent) {
    setDraft({ value: next, source: current, dirty: true });
    setError(null);
  }

  async function save(next: ProjectAccent | null) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setDraft({ value: next, source: current, dirty: false });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save sidebar accent. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className="grid min-w-0 gap-3" disabled={saving} aria-label="Sidebar accent">
      <ToggleGroup
        aria-label="Sidebar accent mode"
        value={[advanced ? "advanced" : "simple"]}
        onValueChange={(modes) => {
          const mode = modes[0];
          if (mode === "advanced" && typeof value === "string") {
            edit({ idle: value, active: value, selected: value });
          } else if (mode === "simple" && typeof value !== "string") {
            edit(value.idle);
          }
        }}
      >
        <Toggle value="simple">Simple</Toggle>
        <Toggle value="advanced">Advanced</Toggle>
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">
        {advanced
          ? "Set exact gradient colours for idle, active and selected threads. Simple mode uses the idle colour."
          : "Choose one colour for automatic idle, active and selected gradient tints."}
      </p>
      {rows.map(({ key, label, color }) => {
        const validColor = decodeColor(color);
        const changeColor = (next: string) =>
          edit(typeof value === "string" ? next : { ...value, [key]: next });
        return (
          <div key={key} className="grid gap-2">
            <label htmlFor={`${id}-${key}`} className="text-xs font-medium">
              {label} colour
            </label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${label} presets`}>
              {PRESETS.map(([name, preset]) => (
                <button
                  key={name}
                  type="button"
                  aria-label={`${label}: ${name}`}
                  aria-pressed={color.trim().toLowerCase() === preset}
                  className="size-6 rounded-full border border-input ring-offset-2 ring-offset-background aria-pressed:ring-2 aria-pressed:ring-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  style={{ backgroundColor: preset }}
                  onClick={() => changeColor(preset)}
                />
              ))}
            </div>
            <div className="flex max-w-64 items-center gap-2">
              <input
                type="color"
                aria-label={`${label} colour picker`}
                className="size-8 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
                value={Option.getOrElse(validColor, () => DEFAULT_COLOR)}
                onChange={(event) => changeColor(event.currentTarget.value)}
              />
              <Input
                id={`${id}-${key}`}
                aria-label={`${label} hex colour`}
                aria-invalid={Option.isNone(validColor)}
                aria-describedby={Option.isNone(validColor) ? `${id}-${key}-error` : undefined}
                value={color}
                onChange={(event) => changeColor(event.currentTarget.value)}
                className="font-mono"
                spellCheck={false}
              />
            </div>
            {Option.isNone(validColor) && (
              <p id={`${id}-${key}-error`} className="text-xs text-destructive">
                Enter a six-digit hex colour, such as #1688f0.
              </p>
            )}
          </div>
        );
      })}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saving || !draft.dirty || Option.isNone(parsed)}
          onClick={() => {
            if (Option.isSome(parsed)) void save(parsed.value);
          }}
        >
          {saving ? "Saving…" : "Save accent"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving || (current === null && !draft.dirty && draft.value === null)}
          onClick={() => void save(null)}
        >
          Reset
        </Button>
      </div>
    </fieldset>
  );
}
