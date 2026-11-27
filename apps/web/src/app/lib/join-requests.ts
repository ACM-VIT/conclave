// A tab's join requests on its connection. Only the newest is the tab's: an
// older request still waiting when a newer one begins settles as
// "overtaken", whatever the server answers it, so its answer is never
// applied over the newer one's.
export const beginJoinRequest = (newest: { current: number }) => {
  const mine = ++newest.current;
  const isNewest = () => newest.current === mine;
  return {
    isNewest,
    settleWith: <T>(
      resolve: (value: T | "overtaken") => void,
      reject: (error: Error) => void,
    ) => ({
      resolve: (value: T) => resolve(isNewest() ? value : "overtaken"),
      reject: (error: Error) => (isNewest() ? reject(error) : resolve("overtaken")),
    }),
  };
};
