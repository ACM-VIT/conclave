/**
 * The socket events the server registered handlers for. A report names its
 * socket event only when it is one of these: a name our own code wrote.
 */
const registered = new Set<string>();
const MAX_SOCKET_EVENTS = 1000;

export const noteSocketEvent = (name: string): void => {
  if (registered.size < MAX_SOCKET_EVENTS) registered.add(name);
};

export const isSocketEvent = (name: string): boolean => registered.has(name);
