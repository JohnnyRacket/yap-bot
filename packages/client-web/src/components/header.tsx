import { PanelRight, PanelRightClose } from "lucide-react";
import type { Snapshot } from "@/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

/** No bar: the agent's name and connection over the chat, and the settings button at the window's edge. */
export function Header({ snap, panelOpen, showToggle, onTogglePanel }: { snap: Snapshot; panelOpen: boolean; showToggle: boolean; onTogglePanel: () => void }) {
  return (
    <header className="relative flex-none pt-[env(safe-area-inset-top)]">
      <div className="flex h-14 flex-col items-center justify-center px-16 text-center leading-tight">
        <div className="max-w-full truncate text-[15px] font-semibold">{snap.brand.title}</div>
        <div className="flex max-w-full items-center gap-1.5 truncate text-xs text-muted-foreground">
          <span className={cn("size-1.5 flex-none rounded-full", snap.conn.tone === "ok" ? "bg-good" : snap.conn.tone === "bad" ? "bg-destructive" : "animate-pulse bg-warn")} />
          <span className="truncate">{snap.conn.tone === "ok" ? (snap.agent ?? "Connected") : snap.conn.text}</span>
        </div>
      </div>
      {showToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onTogglePanel}
              aria-label={panelOpen ? "Hide settings" : "Show settings"}
              aria-pressed={panelOpen}
              className="absolute top-[calc(env(safe-area-inset-top)+0.625rem)] right-4 text-muted-foreground hover:text-foreground"
            >
              {panelOpen ? <PanelRightClose className="size-[18px]" /> : <PanelRight className="size-[18px]" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{panelOpen ? "Hide settings" : "Show settings"}</TooltipContent>
        </Tooltip>
      )}
    </header>
  );
}
