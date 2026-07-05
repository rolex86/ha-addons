const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};

function createLogger(level = "info") {
  const activeLevel = LEVELS[level] || LEVELS.info;

  function log(name, message, meta) {
    if ((LEVELS[name] || LEVELS.info) < activeLevel) {
      return;
    }

    const prefix = `[nas-stremio-bridge] ${name.toUpperCase()}`;
    if (meta !== undefined) {
      console.log(prefix, message, meta);
      return;
    }

    console.log(prefix, message);
  }

  return {
    trace: (message, meta) => log("trace", message, meta),
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta)
  };
}

module.exports = {
  createLogger
};
