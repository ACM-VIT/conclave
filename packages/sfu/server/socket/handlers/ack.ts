export const respond = <T>(callback: unknown, payload: T): void => {
  if (typeof callback === "function") {
    (callback as (response: T) => void)(payload);
  }
};
