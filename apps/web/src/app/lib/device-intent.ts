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

export const acceptsCapture = (state: DeviceIntents, device: Device, request: number): boolean =>
  state[device].capturing && state[device].request === request;

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

export type HeldDevices = {
  holds: (device: Device) => boolean;
  keep: (device: Device, track: MediaStreamTrack) => void;
  drop: (device: Device) => void;
};

export const chooseDevice = (
  store: DeviceIntentStore,
  held: HeldDevices,
  device: Device,
  chosen: boolean,
): void => {
  store.dispatch({ type: "choose", device, chosen });
  if (!chosen) held.drop(device);
};

export type CaptureOutcome = "kept" | "failed" | "stale";

export const captureDevices = async (
  store: DeviceIntentStore,
  held: HeldDevices,
  devices: readonly Device[],
  open: (isCurrent: (device: Device) => boolean) => Promise<readonly MediaStreamTrack[]>,
): Promise<{ outcomes: Partial<Record<Device, CaptureOutcome>>; error: unknown }> => {
  const requests = new Map<Device, number>();
  devices.forEach((device) => {
    requests.set(device, store.dispatch({ type: "capture", device })[device].request);
  });
  const isCurrent = (device: Device) => {
    const request = requests.get(device);
    return request !== undefined && acceptsCapture(store.get(), device, request);
  };
  let tracks: readonly MediaStreamTrack[] = [];
  let error: unknown = null;
  try {
    tracks = await open(isCurrent);
  } catch (caught) {
    error = caught;
  }
  const kept = new Set<MediaStreamTrack>();
  const outcomes: Partial<Record<Device, CaptureOutcome>> = {};
  devices.forEach((device) => {
    const request = requests.get(device)!;
    if (!isCurrent(device)) {
      outcomes[device] = "stale";
      return;
    }
    const track = tracks.find((candidate) => candidate.kind === device && candidate.readyState === "live");
    if (track) {
      kept.add(track);
      held.keep(device, track);
      store.dispatch({ type: "settle", device, request, chosen: true });
      outcomes[device] = "kept";
      return;
    }
    store.dispatch({ type: "settle", device, request, chosen: held.holds(device) });
    outcomes[device] = "failed";
  });
  tracks.forEach((track) => {
    if (!kept.has(track)) track.stop();
  });
  return { outcomes, error };
};

export const handOffDevices = (store: DeviceIntentStore): { mic: boolean; camera: boolean } => {
  const { audio, video } = store.get();
  store.dispatch({ type: "set", audio: audio.chosen, video: video.chosen });
  return { mic: audio.chosen, camera: video.chosen };
};
