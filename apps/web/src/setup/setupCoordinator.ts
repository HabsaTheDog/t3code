const RUN_SETUP_EVENT = "study-buddy:run-setup";

export function requestSetupRerun(): void {
  window.dispatchEvent(new Event(RUN_SETUP_EVENT));
}

export function subscribeSetupRerun(listener: () => void): () => void {
  window.addEventListener(RUN_SETUP_EVENT, listener);
  return () => window.removeEventListener(RUN_SETUP_EVENT, listener);
}
