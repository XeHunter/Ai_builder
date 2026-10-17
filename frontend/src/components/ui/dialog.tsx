import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

interface ContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  title: string;
  description?: string;
  /** "right" renders a full-height side sheet (used for detail drawers). */
  side?: "center" | "right";
  size?: "sm" | "md" | "lg" | "xl";
}

const sizes = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

export function DialogContent({ title, description, side = "center", size = "md", className, children, ...props }: ContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30" />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 flex flex-col bg-surface shadow-[var(--shadow-pop)] focus:outline-none",
          side === "center"
            ? cn("left-1/2 top-1/2 max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl", sizes[size])
            : cn("right-0 top-0 h-full w-full border-l border-border", size === "xl" ? "max-w-3xl" : "max-w-xl"),
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className={description ? "mt-0.5 text-sm text-muted-foreground" : "sr-only"}>
              {description ?? title}
            </DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("-mx-5 -mb-4 mt-4 flex justify-end gap-2 border-t border-border px-5 py-3", className)} {...props} />;
}
