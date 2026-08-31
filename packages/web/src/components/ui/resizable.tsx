import * as React from "react"
import { GripVertical } from "lucide-react"
import { Group, Panel, Separator } from "react-resizable-panels"

import { cn } from "@/lib/utils"

// react-resizable-panels v4: Group/Panel manage their own flex layout styles.
// Sizes are PERCENT only when passed as strings ("25"); numbers mean pixels.
const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof Group>) => (
  <Group
    className={cn("data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)}
    {...props}
  />
)

const ResizablePanel = Panel

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean
}) => (
  <Separator
    className={cn(
      // v4 note: a separator inside a HORIZONTAL group gets aria-orientation="vertical"
      // (it visually divides side-by-side panels); inside a VERTICAL group it's "horizontal".
      "relative shrink-0 bg-border transition-colors after:absolute after:content-[''] hover:bg-input",
      // horizontal group: thin vertical bar, generous invisible hit area
      "w-px after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2",
      // vertical group: thin horizontal bar
      "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:[&>div]:rotate-90",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-6 w-3 items-center justify-center rounded-sm border border-border bg-card shadow-sm">
        <GripVertical className="h-2.5 w-2.5 text-muted-foreground" />
      </div>
    )}
  </Separator>
)

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
