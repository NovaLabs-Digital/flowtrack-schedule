// A tiny pub/sub bus so any component (schedule grid, appointment modal,
// client list, staff/services panels, etc.) can report a completed action to
// the active Interactive Business Experience without needing to be a
// descendant of DemoExperienceProvider or thread markAction through props.
// useDemoExperience subscribes once and ignores anything that doesn't match
// the current step, so calling this outside a tester session (or with no
// tour active) is always a harmless no-op.
type Listener = (actionId: string) => void;

const listeners = new Set<Listener>();

export function notifyDemoAction(actionId: string) {
  listeners.forEach((listener) => listener(actionId));
}

export function subscribeDemoAction(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
