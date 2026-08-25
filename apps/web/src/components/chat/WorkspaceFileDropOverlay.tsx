import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Full-surface drop treatment shared by the chat and files-view drop targets. */
export function WorkspaceFileDropOverlay(
  props: { icon: ReactNode; label: string } & ComponentPropsWithoutRef<"div">,
) {
  const { icon, label, ...rest } = props;
  return (
    <div
      className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
      {...rest}
    >
      <div
        role="status"
        className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
      >
        {icon}
        {label}
      </div>
    </div>
  );
}
