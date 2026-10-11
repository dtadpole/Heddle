/**
 * The events Heveld's own plugins listen for.
 *
 * Cordis types every event name against its `Events` interface, and a plugin adds
 * its events by merging into it. Declaring them in one file keeps the set
 * discoverable instead of scattered across the plugins that emit them.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The application finished loading and is ready to do work.
     *
     * @param target - who the run is for, as resolved from the CLI or the app options.
     */
    'heveld/ready'(target: string): void
  }
}

export {}
