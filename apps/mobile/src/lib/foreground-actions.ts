type ForegroundAction = "leave" | "open" | "toggle-mute";

type ForegroundActionHandlers = {
  onLeave?: () => void;
  onOpen?: () => void;
  onToggleMute?: () => void;
};

let handlers: ForegroundActionHandlers = {};

export const setForegroundActionHandlers = (
  nextHandlers: ForegroundActionHandlers
) => {
  handlers = nextHandlers;
};

export const clearForegroundActionHandlers = () => {
  handlers = {};
};

export const dispatchForegroundAction = (action?: string) => {
  if (!action) return;
  if (action === "leave") {
    handlers.onLeave?.();
    return;
  }
  if (action === "open") {
    handlers.onOpen?.();
    return;
  }
  if (action === "toggle-mute") {
    handlers.onToggleMute?.();
  }
};
