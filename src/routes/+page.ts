// Ozon credentials live in localStorage, so the dashboard can only be rendered
// in the browser. Without this the SSR pass still runs the SWR fetcher, which
// cannot work server-side (relative fetch + no credentials) and always emits an
// empty skeleton.
export const ssr = false;
