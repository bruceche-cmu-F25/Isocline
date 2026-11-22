/** Asks the workspace to show the first run again, on this device: Settings sends it, App.tsx listens. Apart from
 * both, so that the app does not need Settings' code to listen for it. */
export const SHOW_FIRST_RUN = "alfred:first-run";
