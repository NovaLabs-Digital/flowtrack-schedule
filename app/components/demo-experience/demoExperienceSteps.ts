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
  // A related action that does NOT complete this step (e.g. selecting an
  // appointment that cannot be edited). The step stays put and shows
  // rejectedHint so the visitor knows why and what to do instead.
  rejectedActionId?: string;
  rejectedHint?: string;
};

// Steps 0-6 (Welcome, Schedule, Appointment Details, Edit Service, Clients,
// Employees, Services) per the approved storyboard. Steps 7-10 (Add
// Appointment, Mobile, Explore, Completion) are added in later milestones.
//
// "dispatch-insights" (added after the original storyboard shipped) covers
// Projected Revenue, Weekly Worked Hours, Employee Worked Hours, and Job
// Tracking together in a single step -- all four live in the same
// right-hand dispatch sidebar the tester is already looking at right after
// selecting an appointment, so one combined, non-action step (view only,
// like Welcome/Completion) explains them without lengthening the tour with
// four near-identical "look at this card" steps. It comes BEFORE
// "appointment-details" so that clicking Edit leads straight into
// "edit-service" with the editor staying open.
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
    body: "Use Today, Prev, or Next to find an upcoming scheduled appointment. Click its card to view details. Edit works only on future appointments; completed, cancelled, and past appointments cannot be edited.",
    // Today/Prev/Next stay inside the spotlight so the visitor can move to
    // another day or week while looking for an editable appointment.
    targetSelector: '[data-tour="schedule-nav"], [data-tour="schedule-grid"]',
    actionRequired: true,
    // Reported only for appointments that pass isHistoricalAppointment
    // (see DashboardShell's selectAppointment).
    actionId: "select-appointment",
    rejectedActionId: "select-uneditable-appointment",
    rejectedHint: "That appointment can't be edited. Edit works only on future appointments, not completed, cancelled, or past ones. Use Today, Prev, or Next to find an upcoming scheduled appointment.",
  },
  {
    id: "dispatch-insights",
    title: "Revenue & Worked Hours",
    body: "This panel keeps you on top of the business at a glance. Projected Revenue estimates income and hours for your selected date range. Weekly Worked Hours and Employee Worked Hours track what your team has actually logged, backed by automatic Job Tracking as employees clock in and out.",
    targetSelector: '[data-tour="dispatch-sidebar"]',
    actionRequired: false,
  },
  {
    id: "appointment-details",
    title: "Appointment Details",
    body: "Click the highlighted Edit button to change this appointment. Tip: double-clicking a scheduled appointment card also opens Edit.",
    // The real Edit button, which AppointmentDetailPanel renders only for an
    // editable appointment.
    targetSelector: '[data-tour="appointment-edit"]',
    actionRequired: true,
    actionId: "click-edit-appointment",
  },
  {
    id: "edit-service",
    title: "Edit the Service",
    body: "Change the service, then save. Every service has its own duration and color, and the schedule updates immediately.",
    // Spotlights the whole modal, not just the <select> — the required
    // action also needs the Save button clickable, which sits outside the
    // selector's own small rect and would otherwise be dimmed-and-blocked.
    targetSelector: '[data-tour="appointment-modal"]',
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
    body: "Assign colors to employees so they're instantly recognizable throughout the schedule. Edit an employee, choose a new color, and save to continue.",
    // The tour opens Settings → Employees for this step. Spotlights the
    // whole Employees panel so each employee's Edit button, the edit form,
    // and its Save Changes button are all visible and clickable.
    targetSelector: '[data-tour="employees-area"]',
    actionRequired: true,
    actionId: "change-employee-color",
  },
  {
    id: "services",
    title: "Services",
    body: "Services determine duration, default color, and description. Create a new service, then delete it, to continue.",
    // The tour opens Settings → Services for this step.
    targetSelector: '[data-tour="services-area"]',
    actionRequired: true,
    actionId: "delete-service",
  },
  {
    id: "add-appointment",
    title: "Create an Appointment",
    body: "Let's create your first appointment. Click “Add Appointment” to schedule a new customer.",
    targetSelector: '[data-tour="add-appointment"]',
    actionRequired: true,
    actionId: "create-appointment",
  },
  {
    id: "mobile-experience",
    title: "Mobile Admin",
    body: "Everything you've done today is also available from your phone. Manage appointments. View clients. Create new jobs. Update schedules. Anywhere. Spend a moment interacting with the mobile preview, then open any tab to continue.",
    targetSelector: '[data-tour="mobile-preview"]',
    actionRequired: true,
    actionId: "open-mobile-tab",
  },
  {
    id: "completion",
    // Rendered with a fully custom layout in DemoExperienceOverlay (checklist,
    // transition headline, two CTA buttons) rather than the standard
    // title/body/Next footer — title/body kept here only as a plain-text
    // fallback description of this step's purpose.
    title: "Congratulations!",
    body: "You have successfully experienced ScheduleFlowTrack.",
    targetSelector: null,
    actionRequired: false,
  },
];
