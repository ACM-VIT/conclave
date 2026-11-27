export const respond = <T>(
  callback: ((response: T) => void) | undefined,
  payload: NoInfer<T>,
): void => {
  if (typeof callback === "function") {
    callback(payload);
  }
};
