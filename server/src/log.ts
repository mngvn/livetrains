/** Timestamped console logging, kept deliberately small. */
const stamp = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (msg: string) => console.log(`${stamp()} ${msg}`),
  warn: (msg: string) => console.warn(`${stamp()} WARN ${msg}`),
  error: (msg: string, err?: unknown) => {
    const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
    console.error(`${stamp()} ERROR ${msg}${detail}`);
  },
};
