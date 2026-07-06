export type DemoExperienceStep = {
  id: string;
  title: string;
  body: string;
  // data-tour selector to spotlight, or null for a centered/modal-style step
  // (e.g. Welcome, Completion) with no specific target element.
  targetSelector: string | null;
  // When true, the step only advances when the matching real UI action calls
  // markAction(actionId) — it does not show a "Next" button. When false, a
  // "Next" button advances it manually (used for Welcome/Completion/explain
  // steps that have no required action).
  actionRequired: boolean;
  actionId?: string;
};

// Milestone 1 scaffold only — a single placeholder step to prove the
// spotlight/overlay mechanism. Steps 1-10 from the approved storyboard are
// built in later milestones and will replace this array.
export const DEMO_EXPERIENCE_STEPS: DemoExperienceStep[] = [
  {
    id: "placeholder",
    title: "Spotlight Preview",
    body: "This is a placeholder step proving the spotlight/overlay mechanism works end to end. The real guided steps (Schedule, Appointment Details, Clients, Employees, Services, and more) replace this in later milestones.",
    targetSelector: '[data-tour="add-appointment"]',
    actionRequired: false,
  },
];
