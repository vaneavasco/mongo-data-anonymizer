export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function write(level: string, message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

export const consoleLogger: Logger = {
  info: (message) => write('INFO ', message),
  warn: (message) => write('WARN ', message),
  error: (message) => write('ERROR', message),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
