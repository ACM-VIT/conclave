const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  underscore: "\x1b[4m",
  blink: "\x1b[5m",
  reverse: "\x1b[7m",
  hidden: "\x1b[8m",

  fg: {
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    gray: "\x1b[90m",
  },
  bg: {
    black: "\x1b[40m",
    red: "\x1b[41m",
    green: "\x1b[42m",
    yellow: "\x1b[43m",
    blue: "\x1b[44m",
    magenta: "\x1b[45m",
    cyan: "\x1b[46m",
    white: "\x1b[47m",
  },
};

const getTimestamp = () => {
  return new Date().toISOString().split("T")[1].slice(0, -1);
};

const PREFIX = `${colors.fg.magenta}[SFU]${colors.reset}`;

type LogLevel = "error" | "warn" | "info" | "debug";

const levelOrder: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const resolveLogLevel = (): LogLevel => {
  const envLevel = (
    process.env.SFU_LOG_LEVEL ||
    process.env.LOG_LEVEL ||
    ""
  ).toLowerCase();
  if (envLevel in levelOrder) {
    return envLevel as LogLevel;
  }
  return process.env.NODE_ENV === "production" ? "warn" : "info";
};

const activeLogLevel = resolveLogLevel();

const shouldLog = (level: LogLevel) => {
  return levelOrder[level] <= levelOrder[activeLogLevel];
};

export const Logger = {
  info: (message: string, ...args: unknown[]) => {
    if (!shouldLog("info")) return;
    console.log(
      `${colors.dim}${getTimestamp()}${colors.reset} ${PREFIX} ${
        colors.fg.cyan
      }INFO${colors.reset}  ${message}`,
      ...args,
    );
  },

  success: (message: string, ...args: unknown[]) => {
    if (!shouldLog("info")) return;
    console.log(
      `${colors.dim}${getTimestamp()}${colors.reset} ${PREFIX} ${
        colors.fg.green
      }SUCCESS${colors.reset}  ${message}`,
      ...args,
    );
  },

  warn: (message: string, ...args: unknown[]) => {
    if (!shouldLog("warn")) return;
    console.warn(
      `${colors.dim}${getTimestamp()}${colors.reset} ${PREFIX} ${
        colors.fg.yellow
      }WARN${colors.reset}  ${message}`,
      ...args,
    );
  },

  error: (message: string, ...args: unknown[]) => {
    if (!shouldLog("error")) return;
    console.error(
      `${colors.dim}${getTimestamp()}${colors.reset} ${PREFIX} ${
        colors.fg.red
      }ERROR${colors.reset}  ${message}`,
      ...args,
    );
  },

  debug: (message: string, ...args: unknown[]) => {
    if (!shouldLog("debug")) return;
    console.log(
      `${colors.dim}${getTimestamp()}${colors.reset} ${PREFIX} ${
        colors.fg.gray
      }DEBUG${colors.reset}  ${message}`,
      ...args,
    );
  },
};
