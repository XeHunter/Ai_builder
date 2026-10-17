import { Check, Copy } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button, type ButtonProps } from "@/components/ui/button";

import { copyText } from "./channel-meta";

/** Copies `text` to the clipboard and confirms with a check mark (falls back to a toast with manual-copy advice). */
export function CopyButton({ text, label = "Copy", size = "sm", variant = "outline", ...props }: { text: string; label?: string } & Omit<ButtonProps, "onClick" | "children">) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      aria-label={label}
      onClick={async () => {
        if (await copyText(text)) setCopied(true);
        else toast.error("Clipboard unavailable: select the text and copy it manually");
      }}
      {...props}
    >
      {copied ? <Check className="text-success" aria-hidden /> : <Copy aria-hidden />}
      {size !== "icon" && (copied ? "Copied" : "Copy")}
    </Button>
  );
}

/** Monospace snippet with a copy button. */
export function CodeSnippet({ code, label }: { code: string; label: string }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-12 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{code}</pre>
      <CopyButton text={code} label={label} size="icon" variant="ghost" className="absolute right-1.5 top-1.5 h-7 w-7" />
    </div>
  );
}
