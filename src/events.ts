/**
 * The events Heddle's own plugins listen for.
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
    'heddle/ready'(target: string): void

    /**
     * Something in the composed tree is wrong in a way that only shows once every plugin has
     * loaded — a configuration naming a tool that nothing registered, for instance.
     *
     * A lifecycle event rather than a thrown error because row order is not load order: the
     * plugin that would have provided the missing thing may start after the one that noticed.
     * The CLI listens and makes the run fail, so a typo in a profile is not a log line nobody
     * reads.
     *
     * @param payload - which plugin reported, and what it could not find.
     * @mode emit
     */
    'heddle/config-problem'(payload: { readonly plugin: string; readonly problems: readonly string[] }): void
  }
}

export {}
