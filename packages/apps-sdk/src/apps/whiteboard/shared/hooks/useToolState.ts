import { useState } from "react";
import { DEFAULT_TOOL_SETTINGS } from "../constants/tools";
import type { ToolKind, ToolSettings } from "../../core/tools/engine";

export const useToolState = () => {
  // Pen first: a fresh board should be drawable the moment it opens
  const [tool, setTool] = useState<ToolKind>("pen");
  const [settings, setSettings] = useState<ToolSettings>({ ...DEFAULT_TOOL_SETTINGS });

  return {
    tool,
    setTool,
    settings,
    setSettings,
  };
};
