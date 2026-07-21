const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info", output = console) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (name, message, details) => {
    if (LEVELS[name] < threshold) return;
    const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    const method = name === "debug" ? "log" : name;
    (output[method] || output.log).call(output, `[${name}] ${message}${suffix}`);
  };
  return {
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  };
}
