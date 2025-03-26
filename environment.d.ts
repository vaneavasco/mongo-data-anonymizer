import { Config } from './src/config';

declare global {
  namespace NodeJS {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface ProcessEnv
      extends Pick<Record<keyof Config, string>, keyof Config> {}
  }
}
