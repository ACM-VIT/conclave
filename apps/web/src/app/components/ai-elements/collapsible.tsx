"use client";

// Thin Radix Collapsible re-export so the ported AI Elements primitives (Task)
// have the same building block they expect, without a full shadcn install.

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@radix-ui/react-collapsible";

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
