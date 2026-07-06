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
  // Overrides the default "Next" label for non-action steps.
  nextLabel?: string;
};

// Steps 0-6 (Welcome, Schedule, Appointment Details, Edit Service, Clients,
// Employees, Services) per the approved storyboard. Steps 7-10 (Add
// Appointment, Mobile, Explore, Completion) are added in later milestones.
export const DEMO_EXPERIENCE_STEPS: DemoExperienceStep[] = [
  {
    id: "welcome",
    title: "Welcome to the Experience",
    body: "Experience. Interact. Simulate. This is not a tutorial — it's an interactive business simulation built around a complete fictional service company. Feel free to create, edit, move, delete, and experiment. Nothing you do affects a real business.",
    targetSelector: null,
    actionRequired: false,
    nextLabel: "Start the Experience",
  },
  {
    id: "schedule",
    title: "Your Schedule",
    body: "This is today's work schedule. Every appointment contains the client, employee, service, and important information.",
    targetSelector: '[data-tour="schedule-grid"]',
    actionRequired: true,
    actionId: "select-appointment",
  },
  {
    id: "appointment-details",
    title: "Appointment Details",
    body: "Every appointment is your control center. Call, message, edit, cancel, and view notes — all from one place.",
    targetSelector: '[data-tour="appointment-detail"]',
    actionRequired: true,
    actionId: "click-edit-appointment",
  },
  {
    id: "edit-service",
    title: "Edit the Service",
    body: "Change the service, then save. Every service has its own duration and color, and the schedule updates immediately.",
    targetSelector: '[data-tour="service-selector"]',
    actionRequired: true,
    actionId: "save-service",
  },
  {
    id: "clients",
    title: "Clients",
    body: "Your customer database contains everything you need before arriving — phone, address, notes, gate codes, and communication preferences.",
    targetSelector: '[data-tour="clients-list"]',
    actionRequired: true,
    actionId: "open-client",
  },
  {
    id: "employees",
    title: "Employees",
    body: "Assign colors to employees so they're instantly recognizable throughout the schedule. Open Settings, then Staff / Team — edit an employee, choose a new color, and save to continue.",
    targetSelector: '[data-tour="employee-color-swatch"]',
    actionRequired: true,
    actionId: "change-employee-color",
  },
  {
    id: "services",
    title: "Services",
    body: "Services determine duration, default color, and description. In Settings → Services, create a new service, then delete it, to continue.",
    targetSelector: '[data-tour="services-area"]',
    actionRequired: true,
    actionId: "delete-service",
  },
];
