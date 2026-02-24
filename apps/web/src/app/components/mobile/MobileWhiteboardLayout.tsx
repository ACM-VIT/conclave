"use client";

import { memo } from "react";
import { WhiteboardWebApp } from "@conclave/apps-sdk/whiteboard/web";

function MobileWhiteboardLayout() {
  return (
    <div className="w-full h-full min-h-0 min-w-0 p-3">
      <div className="w-full h-full min-h-0 min-w-0 mobile-tile bg-[#0b0b0b] overflow-hidden">
        <WhiteboardWebApp />
      </div>
    </div>
  );
}

export default memo(MobileWhiteboardLayout);
