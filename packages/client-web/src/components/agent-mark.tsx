import { AudioLines } from "lucide-react";
import { cn } from "@/lib/utils.ts";

/** The agent's emoji when it has one (ui.icon), else a plain sound-wave mark in the accent color. */
export function AgentMark({ icon, className }: { icon?: string; className?: string }) {
  return (
    <div className={cn("grid place-items-center rounded-full bg-secondary", className)}>
      {icon ? <span aria-hidden>{icon}</span> : <AudioLines className="size-[42%] text-primary" strokeWidth={2} aria-hidden />}
    </div>
  );
}
