import Link from "next/link";
import { SUPPORT_EMAIL, SUPPORT_MAILTO_URL } from "@/lib/support";

export const metadata = {
  title: "Privacy Policy — Schedule FlowTrack",
  description: "Privacy Policy for ScheduleFlowTrack, provided by Nova Labs Digital LLC.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#0f172a] text-white text-xs font-bold">
              FTS
            </div>
            <span className="text-sm font-semibold text-slate-900">Schedule FlowTrack</span>
          </Link>
          <Link href="/login" className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
            ← Back to Login
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold text-slate-900">ScheduleFlowTrack Privacy Policy</h1>
        <p className="mt-2 text-sm text-slate-500">Effective Date: July 25, 2026</p>

        <div className="mt-8 space-y-8 text-sm leading-relaxed text-slate-700">
          <section>
            <h2 className="text-base font-semibold text-slate-900">1. Scope</h2>
            <p className="mt-2">
              This Privacy Policy describes how Nova Labs Digital LLC (&quot;Nova Labs Digital,&quot; &quot;we,&quot;
              &quot;us,&quot; or &quot;our&quot;) handles information in connection with ScheduleFlowTrack (the
              &quot;Service&quot;). It applies to business owners who subscribe to the Service (&quot;account
              owners&quot;), the employees they add to their account, and the clients whose information account
              owners enter into the Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">2. Information Provided by Account Owners</h2>
            <p className="mt-2">
              When you create and use a ScheduleFlowTrack account, we process the information you provide directly,
              such as your login email and password, and company information you enter, including business name,
              address, phone number, and email address.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">3. Information About Employees and Clients Entered by Subscribing Businesses</h2>
            <p className="mt-2">
              Account owners may enter information about their own employees (such as name, login email, and
              position) and their own clients (such as name, phone number, email address, and address) into the
              Service. This information is provided and controlled by the subscribing business, not by Nova Labs
              Digital directly. We process it on the business&apos;s behalf to operate the Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">4. Appointment, Scheduling, and Job-Tracking Information</h2>
            <p className="mt-2">
              The Service stores appointment details (service type, scheduling times, recurrence), client notes,
              communication preferences (such as whether a client has opted in to email or SMS reminders), and, for
              subscribing businesses that use it, employee job-tracking information such as job start/completion
              times and manually entered worked hours.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">5. Authentication and Session Information</h2>
            <p className="mt-2">
              To keep you signed in, the Service uses a single signed session cookie that identifies your role
              (business owner, employee, or demo account) and, where applicable, which business account you belong
              to. This cookie is used only to operate authentication and is not used for advertising or cross-site
              tracking.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">6. Technical and Usage Information</h2>
            <p className="mt-2">
              Our infrastructure providers may automatically log standard technical information necessary to operate
              and secure the Service, such as request and error logs. ScheduleFlowTrack does not use third-party
              analytics, advertising, or cross-site tracking tools.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">7. Payment and Subscription Information</h2>
            <p className="mt-2">
              Subscription and billing status (such as plan status and renewal date) is stored to operate your
              account. Payment card details are processed and stored directly by our payment processor, Stripe, and
              are not stored on ScheduleFlowTrack&apos;s own servers.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">8. How Information Is Used</h2>
            <p className="mt-2">
              We use the information described above to operate the Service, including displaying your schedule and
              client information, sending appointment reminders on behalf of subscribing businesses, processing
              subscription billing, providing customer support, and maintaining the security and reliability of the
              Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">9. Email and SMS Notification Processing</h2>
            <p className="mt-2">
              When a subscribing business sends an appointment reminder or notification, the relevant client&apos;s
              email address or phone number and the message content are shared with our email and SMS delivery
              providers solely to deliver that message. These providers do not use this information for their own
              marketing purposes.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">10. Service Providers We Use</h2>
            <p className="mt-2">
              To operate the Service, we use the following categories of service providers: Stripe for payment
              processing and subscription billing; a hosted database and infrastructure provider for storing
              application data; an email delivery provider for sending appointment-related email; an SMS delivery
              provider for sending appointment-related text messages; and a hosting/deployment platform for running
              the application. Each provider only receives the information necessary to perform its function.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">11. Information Sharing</h2>
            <p className="mt-2">
              We do not sell personal information. We share information only with the service providers described
              above, as necessary to operate the Service, or when required by law.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">12. Cookies and Session Storage</h2>
            <p className="mt-2">
              The Service uses a single essential session cookie required to keep you signed in. We do not currently
              use advertising, tracking, or analytics cookies.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">13. Data Retention</h2>
            <p className="mt-2">
              We retain account and business data for as long as an account remains active, and for a reasonable
              period afterward as needed for legitimate business, legal, billing, or security purposes. We do not
              currently apply a single fixed retention period across all data types; retention depends on the type of
              information and the purpose it was collected for.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">14. Read-Only Access and Retention After Cancellation</h2>
            <p className="mt-2">
              Your business data is retained after your trial or paid access ends so that you can return and
              reactivate. For 30 days after access ends, the account owner has read-only access to existing data; the
              underlying business data remains stored after operational access is locked at the end of that period,
              and reactivating restores full access to it.
            </p>
            <p className="mt-2">
              As a matter of current business policy, we may periodically review accounts that remain non-paying and
              inactive for an extended time. Under this policy, an account does not become eligible for deletion
              earlier than 12 months after trial or paid access ended, and we intend to provide at least 30 days&apos;
              notice and an opportunity to reactivate or request your data before any such deletion. Active, paying
              accounts are never included in this kind of review. Some billing, security, fraud-prevention, or
              legally required records may be retained longer than other data, regardless of account status. No
              automated deletion system exists today — this section describes our administrative policy, not a
              current automated process.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">15. Security Practices</h2>
            <p className="mt-2">
              We use reasonable technical safeguards, including encrypted, signed authentication sessions and access
              controls that scope each business&apos;s data separately, to help protect information stored in the
              Service. No method of transmission or storage is completely secure, and we cannot guarantee absolute
              security.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">16. Business Responsibility for Client and Employee Data</h2>
            <p className="mt-2">
              Subscribing businesses are responsible for the client and employee information they enter into the
              Service, including having any consent or legal basis required to collect and process it, and for
              honoring the privacy and communication requests of their own clients and employees.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">17. Your Privacy Choices and Contact Methods</h2>
            <p className="mt-2">
              If you have questions about your information or wish to make a privacy-related request, contact us at{" "}
              <a href={SUPPORT_MAILTO_URL} className="text-blue-700 hover:underline">
                {SUPPORT_EMAIL}
              </a>
              . If you are a client or employee of a business that uses ScheduleFlowTrack and have a question about
              your information, you may also contact that business directly, as they control the information entered
              about you.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">18. Account and Data Deletion Requests</h2>
            <p className="mt-2">
              ScheduleFlowTrack does not currently offer fully automated, self-service account or data deletion.
              To request deletion of your account or data, contact{" "}
              <a href={SUPPORT_MAILTO_URL} className="text-blue-700 hover:underline">
                {SUPPORT_EMAIL}
              </a>
              . We will process valid requests, but we may need to retain certain information, such as billing
              records, where required for legal, tax, fraud-prevention, or legitimate backup purposes, even after a
              deletion request is honored.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">19. Children&apos;s Privacy</h2>
            <p className="mt-2">
              The Service is intended for business use by adults and is not directed to children. We do not knowingly
              collect personal information directly from children.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">20. United States Processing</h2>
            <p className="mt-2">
              The Service is operated from, and information is processed in, the United States. If you access the
              Service from outside the United States, your information will be transferred to and processed in the
              United States.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">21. Changes to This Policy</h2>
            <p className="mt-2">
              We may update this Privacy Policy from time to time. If we make material changes, we will update the
              effective date above. Continued use of the Service after changes take effect constitutes acceptance of
              the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">22. Contact Information</h2>
            <p className="mt-2">
              Questions about this Privacy Policy can be sent to{" "}
              <a href={SUPPORT_MAILTO_URL} className="text-blue-700 hover:underline">
                {SUPPORT_EMAIL}
              </a>
              .
            </p>
          </section>
        </div>

        <div className="mt-12 pt-6 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <Link href="/terms" className="hover:text-slate-700 transition-colors">
            Terms of Service
          </Link>
          <span>Powered by Nova Labs Digital</span>
        </div>
      </main>
    </div>
  );
}
