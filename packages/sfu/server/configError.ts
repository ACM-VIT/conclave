/**
 * A configuration error whose message names the variable and position, never
 * the value. Error reports send its message as is.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
