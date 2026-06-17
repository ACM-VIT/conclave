import { Platform } from "react-native";
import notifee, { EventType } from "@notifee/react-native";
import { dispatchForegroundAction } from "./foreground-actions";

type ForegroundActionEvent = {
  type: EventType;
  detail?: {
    pressAction?: {
      id?: string;
    };
  };
};

if (Platform.OS !== "web") {
  if (Platform.OS === "android") {
    notifee.registerForegroundService(() => {
      return new Promise(() => {});
    });
  }

  const handleEvent = (event: ForegroundActionEvent) => {
    const actionId = event?.detail?.pressAction?.id;
    if (!actionId) return;
    if (event.type === EventType.ACTION_PRESS || event.type === EventType.PRESS) {
      dispatchForegroundAction(actionId);
    }
  };

  notifee.onForegroundEvent(handleEvent);

  notifee.onBackgroundEvent(async (event) => {
    handleEvent(event);
  });
}
