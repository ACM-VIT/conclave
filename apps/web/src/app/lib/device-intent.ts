export type Device = "audio" | "video";

export type DeviceIntent = { chosen: boolean; request: number; capturing: boolean };

export type DeviceIntents = Readonly<Record<Device, DeviceIntent>>;

export type DeviceIntentAction =
  | { type: "choose"; device: Device; chosen: boolean }
  | { type: "capture"; device: Device }
  | { type: "settle"; device: Device; request: number; chosen: boolean }
  | { type: "set"; audio: boolean; video: boolean }
  | { type: "release" };

export const initialDeviceIntents: DeviceIntents = {
  audio: { chosen: false, request: 0, capturing: false },
  video: { chosen: false, request: 0, capturing: false },
};

const supersede = (intent: DeviceIntent, chosen: boolean, capturing = false): DeviceIntent => ({
  chosen,
  request: intent.request + 1,
  capturing,
});

export const reduceDeviceIntents = (state: DeviceIntents, action: DeviceIntentAction): DeviceIntents => {
  switch (action.type) {
    case "choose": {
      const intent = state[action.device];
      if (intent.chosen === action.chosen) return state;
      return { ...state, [action.device]: supersede(intent, action.chosen) };
    }
    case "capture":
      return { ...state, [action.device]: supersede(state[action.device], true, true) };
    case "settle": {
      const intent = state[action.device];
      if (intent.request !== action.request) return state;
      return { ...state, [action.device]: { ...intent, chosen: action.chosen, capturing: false } };
    }
    case "set":
      return { audio: supersede(state.audio, action.audio), video: supersede(state.video, action.video) };
    case "release":
      return { audio: supersede(state.audio, false), video: supersede(state.video, false) };
  }
};

export const publishIntent = (state: DeviceIntents): { isMicOn: boolean; isCameraOn: boolean } => ({
  isMicOn: state.audio.chosen,
  isCameraOn: state.video.chosen,
});

export type DeviceIntentStore = {
  get: () => DeviceIntents;
  dispatch: (action: DeviceIntentAction) => DeviceIntents;
  subscribe: (listener: () => void) => () => void;
};

export const createDeviceIntentStore = (): DeviceIntentStore => {
  let state = initialDeviceIntents;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    dispatch: (action) => {
      const updated = reduceDeviceIntents(state, action);
      if (updated !== state) {
        state = updated;
        listeners.forEach((listener) => listener());
      }
      return state;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export const setDeviceOff = (
  store: DeviceIntentStore,
  device: Device,
  next: boolean | ((off: boolean) => boolean),
): void => {
  const off = typeof next === "function" ? next(!store.get()[device].chosen) : next;
  store.dispatch({ type: "choose", device, chosen: !off });
};
