// ScheduleFlowTrack Learning Center -- Phase 1 guide data.
//
// A simple, maintainable data module (not hardcoded JSX scattered across
// pages) so future guides/videos can be added by extending GUIDES below,
// with no page-level changes required -- app/learn/page.tsx and
// app/learn/[slug]/page.tsx both read from this file alone.
//
// Every instruction below describes the ACTUAL current SFT implementation
// (grounded against the real UI components/wording during Phase 1 --
// AppointmentModal.tsx, MoveConfirmDialog.tsx, RecurringSeriesPanel.tsx,
// ClientPanel.tsx, EmployeeJobActionButton.ts, EmployeeSchedule.tsx,
// AdjustWorkedTimeControl.ts, lib/payroll.ts, IncomeProjection.tsx,
// CompanyInfoPanel.tsx, lib/notify.ts, app/api/cron/reminders/route.ts) --
// nothing here is aspirational or invented.
//
// Kept intentionally free of any React/Next.js import so it can be read by
// both server components (app/learn/[slug]/page.tsx's
// generateStaticParams/generateMetadata) and the client-side search
// component (LearningCenterSearch.ts) without bundling concerns either way.

export type CategoryId =
  | "getting-started"
  | "scheduling-calendar"
  | "clients"
  | "employees-staff"
  | "job-tracking"
  | "worked-hours-payroll"
  | "projected-revenue"
  | "notifications"
  | "mobile"
  | "settings";

export type Category = { id: CategoryId; name: string };

// Declared in this exact order for Phase 1. Some categories (Getting
// Started, Employees & Staff, Mobile, Settings) have no guides yet -- they
// still exist here so search/category lookups behave correctly for topics
// that belong to them (returning "no guides yet," never an error), and so
// the Learning Center's category shape is stable as guides are added to
// them in a later phase.
export const CATEGORIES: Category[] = [
  { id: "getting-started", name: "Getting Started" },
  { id: "scheduling-calendar", name: "Scheduling & Calendar" },
  { id: "clients", name: "Clients" },
  { id: "employees-staff", name: "Employees & Staff" },
  { id: "job-tracking", name: "Job Tracking" },
  { id: "worked-hours-payroll", name: "Worked Hours & Payroll" },
  { id: "projected-revenue", name: "Projected Revenue" },
  { id: "notifications", name: "Notifications" },
  { id: "mobile", name: "Mobile" },
  { id: "settings", name: "Settings" },
];

export function categoryName(id: CategoryId): string {
  return CATEGORIES.find((c) => c.id === id)?.name ?? id;
}

export type Guide = {
  // Also the URL segment: /learn/[slug].
  slug: string;
  title: string;
  category: CategoryId;
  // Short description -- shown on guide cards, search results, and at the
  // top of the guide's own page.
  description: string;
  // Plain-language search terms, deliberately including phrasing an owner
  // would actually type (not just SFT's own feature names) -- see
  // searchGuides below for why this is what lets "forgot clock out" find
  // the same guide as "fix a forgotten clock-in or clock-out."
  keywords: string[];
  // Optional -- a direct video file/link (e.g. an <video> src). Absent in
  // every Phase 1 guide; the guide page must render nothing video-related
  // at all when both this and videoId are absent (no empty video box).
  videoUrl?: string;
  // Optional -- a YouTube video id, embedded via the standard
  // /embed/{videoId} URL. Preferred over videoUrl for a hosted video once
  // one exists; either may be set, never both expected at once, and
  // videoId takes priority if somehow both are.
  videoId?: string;
  // Ordered, written, step-by-step instructions.
  steps: string[];
  // Other guide slugs to surface as "Related guides" -- kept as slugs
  // (not embedded Guide objects) so guides can reference each other
  // without a circular data structure; resolved via getRelatedGuides.
  relatedSlugs?: string[];
};

export const GUIDES: Guide[] = [
  {
    slug: "create-appointment",
    title: "How to Create an Appointment",
    category: "scheduling-calendar",
    description:
      "Schedule a new appointment for an existing or brand-new client, choose a service, assign employees, and decide whether to notify the client.",
    keywords: [
      "new appointment", "book appointment", "schedule a job", "add appointment",
      "create job", "new booking",
    ],
    steps: [
      "From the schedule, open the New Appointment form (click an open time slot, or use the new-appointment action).",
      "Choose an existing client from the dropdown, or click \"+ New Client\" to add one on the spot -- name is required, email and phone are optional.",
      "Pick the Service Type, then set the date, time, and duration.",
      "Assign one or more employees to the job (this can also be left unassigned and set later).",
      "Under \"Send confirmation to client?\", choose email, SMS, both, or none -- it defaults to none, so nothing sends unless you choose it.",
      "Set a price if you want this appointment counted in Projected Revenue.",
      "Save the appointment -- it appears immediately on the schedule.",
    ],
    relatedSlugs: ["move-reschedule-appointment", "recurring-appointments", "add-manage-clients", "email-sms-notifications"],
  },
  {
    slug: "move-reschedule-appointment",
    title: "How to Move or Reschedule an Appointment",
    category: "scheduling-calendar",
    description:
      "Drag an appointment to a new day or time on the schedule, or edit its date and time directly, and choose whether to notify the client.",
    keywords: [
      "reschedule appointment", "drag appointment", "change appointment time",
      "change appointment date", "move a job", "move job",
    ],
    steps: [
      "Drag the appointment card to its new slot on the schedule -- a confirmation dialog opens.",
      "Review the new date and time, then confirm with \"Move Appointment\" (or cancel to leave it where it was).",
      "You can also open the appointment and edit its Date/Time fields directly, then save.",
      "If the appointment is part of a recurring series, choose whether the change applies to \"Only this appointment\" or \"This and future appointments.\"",
      "Choose whether to notify the client of the change -- email, SMS, both, or none.",
    ],
    relatedSlugs: ["create-appointment", "recurring-appointments"],
  },
  {
    slug: "recurring-appointments",
    title: "How Recurring Appointments Work",
    category: "scheduling-calendar",
    description:
      "Set an appointment to repeat Weekly or Monthly, at whatever interval you choose, and manage the whole series from one place.",
    keywords: [
      "repeat appointment", "recurring series", "recurring job", "weekly appointment",
      "biweekly", "every 2 weeks", "monthly appointment", "repeating schedule",
    ],
    steps: [
      "When creating or editing an appointment, set \"Repeat\" to Weekly or Monthly (in addition to One Time, Daily, and Weekdays).",
      "Use \"Repeat Every\" to control the interval -- for example, every 1 week (weekly) or every 2 weeks (biweekly).",
      "Future occurrences generate automatically and stay in sync with the schedule.",
      "To change the pattern, employees, or other details for the whole series, use the \"Manage Recurrence\" panel from any occurrence.",
      "Any recurrence change asks whether it applies only to this occurrence or to this and future ones, and whether to notify affected clients.",
    ],
    relatedSlugs: ["create-appointment", "move-reschedule-appointment"],
  },
  {
    slug: "add-manage-clients",
    title: "How to Add and Manage Clients",
    category: "clients",
    description:
      "Add new clients while booking an appointment, then edit their details and notes and view their full service history from the Clients list.",
    keywords: [
      "add client", "new client", "add customer", "client info", "client notes",
      "gate code", "service history", "archive client",
    ],
    steps: [
      "New clients are added right from the New Appointment form: click \"+ New Client\" and enter their name (required), plus email and phone (optional).",
      "Find any client afterward in the Clients list in the left sidebar.",
      "Select a client to view their contact info, notes (gate codes, pet info, preferences), and full appointment/service history.",
      "Click Edit to update their details or notes, then Save Client.",
      "Turn on \"Auto Email\" and/or \"Auto SMS\" for a client so they automatically receive appointment reminders without you choosing every time.",
      "Archive a client you no longer work with -- their history is preserved, and you can restore them later.",
    ],
    relatedSlugs: ["create-appointment", "email-sms-notifications"],
  },
  {
    slug: "employee-start-complete-job",
    title: "How Employees Start and Complete a Job",
    category: "job-tracking",
    description:
      "Employees tap Start Job when they begin and Complete Job when they finish, which records the exact worked time automatically.",
    keywords: [
      "clock in", "clock out", "start job", "complete job", "job tracking",
      "time tracking", "track hours",
    ],
    steps: [
      "From their schedule, an assigned employee taps \"Start Job\" when they begin working.",
      "When finished, they tap \"Complete Job\" -- this records the exact start and end time.",
      "The recorded duration becomes that employee's worked time for the appointment, used for payroll.",
      "Each employee's Start/Complete actions are tracked independently, so on a multi-employee job, one employee finishing does not affect another's tracking.",
      "If tracking is skipped or produces no valid time, the owner can enter the correct time manually -- see \"How to Fix a Forgotten Clock-In or Clock-Out.\"",
    ],
    relatedSlugs: ["employee-job-notes", "fix-forgotten-clock-out", "review-unusual-worked-time"],
  },
  {
    slug: "employee-job-notes",
    title: "How Employee Job Notes Work",
    category: "job-tracking",
    description:
      "Employees can leave an optional note about how a job went, right from their schedule -- it saves automatically as they type.",
    keywords: [
      "employee notes", "job notes", "notes about job", "autosave note",
    ],
    steps: [
      "On their schedule, each employee has an optional \"Job Notes (optional)\" field for that appointment.",
      "Notes save automatically about a second after they stop typing -- no Save button needed; the field shows \"Saving...\" then \"Saved.\"",
      "Job Notes are separate from the appointment's own owner Notes and from any worked-time correction reason.",
      "Owners can see each employee's Job Notes on the appointment's Worked Hours card, right next to that employee's tracked time.",
      "Job Notes are for context only -- SFT never reads them to change payable hours automatically.",
    ],
    relatedSlugs: ["employee-start-complete-job"],
  },
  {
    slug: "fix-forgotten-clock-out",
    title: "How to Fix a Forgotten Clock-In or Clock-Out",
    category: "worked-hours-payroll",
    description:
      "If Job Tracking is missing or wrong, correct it yourself with a simple Clock-in/Clock-out form -- no manual hour math required.",
    keywords: [
      "forgot clock out", "forgot clock in", "forgot to clock in", "forgot to clock out",
      "wrong employee hours", "fix hours", "missing hours", "correct time", "manual hours",
    ],
    steps: [
      "Open the appointment and find the affected employee on the Worked Hours card.",
      "If no time was ever tracked, you'll see a Clock-in/Clock-out/Reason form directly -- enter the actual times worked and a short reason (e.g. \"forgot to clock in\"), then Save Worked Time.",
      "If a time was already tracked but is wrong, click \"Correct Time\" to open the same Clock-in/Clock-out/Reason form, pre-filled with the original tracked times.",
      "SFT calculates the payable duration automatically from the times you enter -- you never calculate decimal hours yourself.",
      "Saving updates that employee's worked time everywhere it's used, including Weekly Worked Hours, and never changes the employee's own original tracked timestamps.",
    ],
    relatedSlugs: ["employee-start-complete-job", "review-unusual-worked-time", "weekly-worked-hours-payroll"],
  },
  {
    slug: "review-unusual-worked-time",
    title: "How to Review Unusual Worked Time",
    category: "worked-hours-payroll",
    description:
      "SFT flags a worked time that looks off compared to the schedule or a coworker's time on the same job, so you can review it before payroll.",
    keywords: [
      "needs review", "unusual hours", "wrong hours", "wrong employee hours",
      "review worked time", "time doesn't match", "flagged time",
    ],
    steps: [
      "A \"⚠ Needs Review\" badge appears on an employee's Worked Hours card when their tracked time is significantly longer or shorter than expected -- compared to the scheduled duration, or to a coworker's time on the same job.",
      "Open the appointment to see the flagged employee and their tracked duration.",
      "Decide whether the time is wrong (use \"Correct Time\") or actually correct (use \"✓ Keep Time As Is\") -- see \"How Keep Time As Is Works.\"",
      "Either action clears the \"Needs Review\" badge and the review count shown on Weekly Worked Hours.",
      "A flag on one employee never means a coworker on the same job is automatically wrong too -- each employee's time is evaluated on its own.",
    ],
    relatedSlugs: ["keep-time-as-is", "fix-forgotten-clock-out", "weekly-worked-hours-payroll"],
  },
  {
    slug: "keep-time-as-is",
    title: "How \"Keep Time As Is\" Works",
    category: "worked-hours-payroll",
    description:
      "When a flagged worked time is actually correct, confirm it with a reason instead of re-entering a \"correction\" that doesn't change anything.",
    keywords: [
      "keep time as is", "confirm time", "job took longer", "legitimate long job",
      "dismiss review", "reviewed by owner",
    ],
    steps: [
      "When an employee's time is flagged \"Needs Review,\" you'll see two options: \"Correct Time\" and \"✓ Keep Time As Is.\"",
      "Choose \"Keep Time As Is\" when the tracked time is actually correct -- for example, the job legitimately took longer than scheduled.",
      "Enter a short reason (required), e.g. \"Used new equipment, job took longer.\"",
      "The worked time itself is not changed -- it's confirmed exactly as tracked, and Weekly Worked Hours is unaffected.",
      "The card now shows \"Reviewed by owner ✓\" instead of \"Adjusted by owner,\" so it's clear this was a confirmation, not a correction.",
    ],
    relatedSlugs: ["review-unusual-worked-time", "fix-forgotten-clock-out"],
  },
  {
    slug: "weekly-worked-hours-payroll",
    title: "How Weekly Worked Hours Helps Prepare Payroll",
    category: "worked-hours-payroll",
    description:
      "See each employee's total worked hours for a date range, with a review count so you know which totals still need a look before you run payroll.",
    keywords: [
      "payroll", "weekly hours", "total hours", "hours worked report", "pay employees",
    ],
    steps: [
      "Weekly Worked Hours (on the dispatch/schedule dashboard) totals each employee's worked hours for the date range you choose.",
      "Totals use each employee's owner-approved time first, falling back to their tracked Job Tracking time when there's no correction.",
      "An employee with any unresolved \"Needs Review\" flags shows a review count next to their total (e.g. \"Roxana 8.24 hrs ⚠ 1 review\").",
      "Resolve flags with \"Correct Time\" or \"Keep Time As Is\" before finalizing payroll -- the review count drops as each one is handled.",
      "Adjust the date range to match your pay period.",
    ],
    relatedSlugs: ["review-unusual-worked-time", "fix-forgotten-clock-out", "keep-time-as-is"],
  },
  {
    slug: "projected-revenue",
    title: "How Projected Revenue Works",
    category: "projected-revenue",
    description:
      "See estimated revenue for your selected date range, based on the prices set on your scheduled appointments.",
    keywords: [
      "projected revenue", "estimated income", "revenue forecast", "expected earnings",
    ],
    steps: [
      "Projected Revenue (on the dispatch/schedule dashboard) totals the price of appointments scheduled within your selected date range.",
      "It reads the same date range as Weekly Worked Hours, so both stay in sync as you adjust it.",
      "Cancelled appointments are excluded from the total.",
      "Set a price on each appointment (in the appointment form) so it's counted -- an appointment with no price contributes nothing.",
      "This is an estimate based on scheduled appointments, not a record of money actually collected.",
    ],
    relatedSlugs: ["create-appointment", "weekly-worked-hours-payroll"],
  },
  {
    slug: "email-sms-notifications",
    title: "How Email and SMS Appointment Notifications Work",
    category: "notifications",
    description:
      "Choose per appointment whether to notify the client by email, SMS, both, or not at all -- controlled overall by a workspace-wide master switch.",
    keywords: [
      "sms", "text message", "email notification", "confirmation", "reminder",
      "notify client",
    ],
    steps: [
      "Every time you create, reschedule, or cancel an appointment, you choose whether to notify the client right then -- email, SMS, both, or none. It defaults to none, so nothing sends unless you choose it.",
      "Email and SMS choices are only available when the client has an email address or phone number on file.",
      "Automatic reminders before an appointment use each client's own standing preference instead -- turn on \"Auto Email\" and/or \"Auto SMS\" for a client so they receive reminders without you choosing every time.",
      "A workspace-wide notifications master switch (in Settings) controls whether ANY email or SMS goes out at all -- confirmations, reschedules, cancellations, and reminders. When it's off, nothing sends regardless of any per-appointment or per-client choice.",
      "Turning the master switch off is useful for pausing all outbound messages at once, for example during a demo or a transition.",
    ],
    relatedSlugs: ["create-appointment", "move-reschedule-appointment", "add-manage-clients"],
  },
];

export function getGuideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

export function getGuidesByCategory(category: CategoryId, guides: Guide[] = GUIDES): Guide[] {
  return guides.filter((g) => g.category === category);
}

// Resolves a guide's relatedSlugs to real Guide objects, silently dropping
// any slug that doesn't (or no longer) resolve -- a typo or a removed guide
// in relatedSlugs should never crash a page, just show fewer related cards.
export function getRelatedGuides(guide: Guide): Guide[] {
  if (!guide.relatedSlugs?.length) return [];
  return guide.relatedSlugs
    .map((slug) => getGuideBySlug(slug))
    .filter((g): g is Guide => !!g);
}

// Case-insensitive, whole-word-agnostic search across title, description,
// category name, and keywords -- the user should never need to know SFT's
// own terminology. Every query word must appear SOMEWHERE in the combined
// text (as a substring, so "forgot" also matches "forgotten") -- this is
// deliberately simple substring/token matching, not fuzzy/AI search (out of
// scope for Phase 1), but tokenizing on whitespace and requiring each word
// independently (rather than the whole phrase as one substring) is what
// lets a query like "forgot clock out" find a guide whose own wording is
// "forgot to clock in or clock out" without an exact phrase match.
export function searchGuides(query: string, guides: Guide[] = GUIDES): Guide[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return guides;
  return guides.filter((guide) => {
    const haystack = [guide.title, guide.description, categoryName(guide.category), ...guide.keywords]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
